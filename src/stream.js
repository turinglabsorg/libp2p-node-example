import process, { connected } from 'node:process'
import { createLibp2p } from 'libp2p'
import { WebSockets } from '@libp2p/websockets'
import { Noise } from '@chainsafe/libp2p-noise'
import { Mplex } from '@libp2p/mplex'
import { multiaddr } from 'multiaddr'
import { Bootstrap } from '@libp2p/bootstrap'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { createEd25519PeerId, exportToProtobuf, createFromProtobuf } from '@libp2p/peer-id-factory'
import * as lp from 'it-length-prefixed'
import map from 'it-map'
import { pipe } from 'it-pipe'
import fs from 'fs'
import _ from 'lodash'
import crypto from 'crypto'

const time = 60 // Test time in seconds
const throttle = 20
let started = false
let starting = false
let relayed = []
let received = []
let resets = 0
let exchanged = 0
let successful = 0
let errors = 0
const protocol = '/echo/1.0.0'
let node

function handleStream(stream) {
    try {
        pipe(
            // Read from the stream (the source)
            stream.source,
            // Decode length-prefixed data
            lp.decode(),
            // Turn buffers into strings
            (source) => map(source, (buf) => uint8ArrayToString(buf.subarray())),
            // Sink function
            async function (source) {
                // For each chunk of data
                for await (const msg of source) {
                    // Output the data as a utf8 string
                    if (received.indexOf(msg.toString()) === -1) {
                        received.push(msg.toString())
                        console.log('> ' + msg.toString().replace('\n', ''))
                        if (relayed.indexOf(msg.toString()) === -1) {
                            relayed.push(msg.toString())
                            relayMessage(msg)
                        }
                    }
                }
            }
        )
    } catch (e) {
        console.log(e.message)
    }
}

function relayMessage(message) {
    return new Promise(async response => {
        let success = true
        const active = returnBootstrappers()
        for (let k in active) {
            try {
                const ma = multiaddr(active[k])
                const stream = await node.dialProtocol(ma, protocol)
                pipe(
                    [uint8ArrayFromString(message)],
                    (source) => map(source, (string) => uint8ArrayFromString(string)),
                    lp.encode(),
                    stream.sink,
                )
                setTimeout(async function () {
                    try {
                        await stream.abort()
                    } catch (e) {
                        console.log("Can't reset stream..")
                    }
                }, throttle / 3)
            } catch (e) {
                // Uncomment next line to see why stream failed
                console.log("[STREAM FAILED]", e.message)
                success = false
            }
        }
        setTimeout(function () {
            response(success)
        }, throttle / 2)
    })
}

function startStreaming() {
    const bytes = _.random(128, 128, 0)
    crypto.randomBytes(bytes, async (err, buffer) => {
        if (err) {
            // Prints error
            console.log(err);
            return;
        }
        const message = '[' + new Date().getTime() + '] [' + process.argv[2] + '] ' + buffer.toString('hex')
        let sending = true
        while (sending) {
            let response = await relayMessage(message)
            if (!response) {
                resets++
                errors++
                if (!starting && errors > 10) {
                    errors = 0
                    started = false
                    sending = false
                    // Reset node if fails too much
                    await node.stop()
                    startNode()
                }
            } else {
                exchanged += bytes
                successful++
                sending = false
                setTimeout(function () {
                    startStreaming()
                }, throttle)
            }
        }
    });
}

function returnBootstrappers() {
    const bootstrapers = []
    const nodes = fs.readdirSync('./nodes')
    for (let k in nodes) {
        if (nodes[k] !== '.NODES_WILL_APPEAR_HERE') {
            const addresses = fs.readFileSync('./nodes/' + nodes[k]).toString().split("\n")
            for (let j in addresses) {
                if (addresses[j].length > 0 && nodes[k] !== process.argv[2] && addresses[j].indexOf('/ip4/') !== -1) {
                    // console.log('Found address:', addresses[j])
                    bootstrapers.push(addresses[j])
                }
            }
        }
    }
    return bootstrapers
}

async function startNode() {
    if (!starting && !started) {
        starting = true
        // Taking bootstrap nodes
        const bootstrapers = returnBootstrappers()
        // Creating node
        let peerId
        if (fs.existsSync('./nodes/' + process.argv[2] + '_id')) {
            const protobuf = fs.readFileSync('./nodes/' + process.argv[2] + '_id').toString()
            peerId = await createFromProtobuf(Buffer.from(protobuf, 'hex'))
        } else {
            peerId = await createEd25519PeerId()
            fs.writeFileSync('./nodes/' + process.argv[2] + '_id', exportToProtobuf(peerId).toString('hex'))
        }
        try {
            const port = "700" + parseInt(process.argv[2])
            node = await createLibp2p({
                peerId: peerId,
                addresses: {
                    listen: ['/ip4/127.0.0.1/tcp/' + port + '/ws']
                },
                transports: [new WebSockets()],
                connectionEncryption: [new Noise()],
                streamMuxers: [new Mplex()],
                connectionManager: {
                    autoDial: true,
                },
                peerDiscovery: [
                    new Bootstrap({
                        interval: 10e3,
                        list: bootstrapers
                    })
                ]
            })

            // start libp2p
            await node.start()
            console.log('libp2p has started')

            node.connectionManager.addEventListener('peer:connect', async (connection) => {
                console.log('--')
                console.log('Connected to %s', connection.detail.remotePeer) // Log connected peer
            })
            // print out listening addresses
            console.log('listening on addresses:')
            fs.writeFileSync("nodes/" + process.argv[2], '')
            let addresslist = ''
            node.getMultiaddrs().forEach((addr) => {
                console.log(addr.toString())
                addresslist += addr.toString() + "\n"
                fs.writeFileSync("nodes/" + process.argv[2], addresslist)
            })

            // Handle incoming stream
            await node.handle(
                protocol,
                async ({ stream }) => handleStream(stream),
                {
                    maxInboundStreams: 500000,
                    maxOutboundStreams: 500000
                }
            )

            // Starting test stream
            console.log('Starting test..')
            startStreaming()

            started = true
            starting = false
        } catch (e) {
            started = false
            console.log('--')
            console.log(e.message)
            console.log('--')
        }
    }
}

setTimeout(function () {
    startNode()
}, Math.floor(Math.random() * 1000))

setTimeout(function () {
    console.log('Exchanged bytes:', exchanged)
    console.log('Successful relays:', successful)
    console.log('Resets:', resets)
    console.log('Messages received:', received.length)
    console.log('Messages relayed:', relayed.length)
    process.exit()
}, time * 1500)