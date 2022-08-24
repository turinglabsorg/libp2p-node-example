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
import Jetty from 'jetty'

const jetty = new Jetty(process.stdout)
// Configure test from here
const time = 120 // Test time in seconds
const show = false // show messages in console or not
const throttle = 10 // How many ms it will wait between one message and another
const protocol = '/echo/1.0.0' // Protocol name
const size = 2048 // Size of exchanged random buffer

// Node variables
let node
const bootstrapers = returnBootstrappers()
let relayed = []
let received = []

// Useful variables for testing
let started = false
let starting = false
let resets = 0
let exchanged = 0
let successful = 0
let elapsed = 0

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
                        if (show) {
                            console.log('> ' + msg.toString().replace('\n', ''))
                        }
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
                if (show) {
                    console.log("[STREAM FAILED]", e.message)
                }
                await node.hangUp(multiaddr(active[k]))
                resets++
                success = false
            }
        }
        setTimeout(function () {
            response(success)
        }, throttle / 2)
    })
}

function startStreaming() {
    const bytes = _.random(size, size, 0)
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
            if (response) {
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
                if (show) {
                    console.log('--')
                    console.log('Connected to %s', connection.detail.remotePeer) // Log connected peer
                }
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
            console.log('Starting test, results will show up in 5 seconds..')
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

// Print progresses
setTimeout(function () {
    setInterval(function () {
        jetty.clear();
        console.log('Testing libp2p for ' + time + ' seconds, elapsed ' + elapsed, 's.')
        console.log('Using ' + (bootstrapers.length + 1) + ' nodes.')
        console.log('Exchange packages of ' + size + ' size.')
        console.log('Throttle between messages is:', throttle + 'ms.')
        console.log('--')
        console.log('Exchanged bytes:', exchanged)
        console.log('Successful relays:', successful)
        console.log('Connection resets:', resets)
        console.log('Messages received:', received.length)
        console.log('Messages relayed:', relayed.length)
        console.log('Rate KB/s:', (exchanged / elapsed / 1000).toFixed(2))
    }, 500)
}, 5000)

setInterval(function () {
    elapsed++
}, 1000)
setTimeout(function () {
    process.exit()
}, (time + 1) * 1000)