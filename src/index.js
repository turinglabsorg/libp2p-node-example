import process from 'node:process'
import { createLibp2p } from 'libp2p'
import { WebSockets } from '@libp2p/websockets'
import { Noise } from '@chainsafe/libp2p-noise'
import { Mplex } from '@libp2p/mplex'
import { multiaddr } from 'multiaddr'
import { Bootstrap } from '@libp2p/bootstrap'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import * as lp from 'it-length-prefixed'
import map from 'it-map'
import { pipe } from 'it-pipe'
import fs from 'fs'

export function streamToConsole(stream) {
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
                    console.log('> ' + msg.toString().replace('\n', ''))
                }
            }
        )
    } catch (e) {
        console.log(e.message)
    }
}

function startStreaming(node, remoteAddr) {
    // Create new stream each 10ms
    const interval = setInterval(
        async function () {
            try {
                const stream = await node.dialProtocol(remoteAddr, '/echo/1.0.0')
                const message = '[' + new Date().getTime() + '] hey from ' + process.argv[2]
                console.log('>', message)
                pipe(
                    [uint8ArrayFromString(message)],
                    (source) => map(source, (string) => uint8ArrayFromString(string)),
                    lp.encode(),
                    stream.sink
                )
                setTimeout(function () {
                    try {
                        stream.reset()
                    } catch (e) {
                        console.log("Can't close stream..")
                    }
                }, 1)
            } catch (e) {
                console.log("[STREAM FAILED] stopping streaming to peer.")
                console.log(e.message)
                clearInterval(interval)
                setTimeout(function () {
                    startNode()
                }, 500)
            }
        }
        , 10)
}

async function startNode() {
    const bootstrapers = []
    const nodes = fs.readdirSync('./nodes')
    for (let k in nodes) {
        if (nodes[k] !== '.NODES_WILL_APPEAR_HERE') {
            const addresses = fs.readFileSync('./nodes/' + nodes[k]).toString().split("\n")
            for (let j in addresses) {
                if (addresses[j].length > 0 && nodes[k] !== process.argv[2]) {
                    console.log('Found address:', addresses[j])
                    bootstrapers.push(addresses[j])
                }
            }
        }
    }
    try {
        const node = await createLibp2p({
            addresses: {
                listen: ['/ip4/127.0.0.1/tcp/0/ws']
            },
            transports: [new WebSockets()],
            connectionEncryption: [new Noise()],
            streamMuxers: [new Mplex()],
            connectionManager: {
                autoDial: true,
            },
            peerDiscovery: [
                new Bootstrap({
                    interval: 60e3,
                    list: bootstrapers
                })
            ]
        })

        // start libp2p
        await node.start()
        console.log('libp2p has started')

        // print out listening addresses
        console.log('listening on addresses:')
        fs.writeFileSync("nodes/" + process.argv[2], '')
        let addresslist = ''
        node.getMultiaddrs().forEach((addr) => {
            console.log(addr.toString())
            addresslist += addr.toString() + "\n"
            fs.writeFileSync("nodes/" + process.argv[2], addresslist)
        })
        node.connectionManager.addEventListener('peer:connect', async (connection) => {
            try {
                console.log('--')
                console.log('Connected to %s', connection.detail.remoteAddr) // Log connected peer
                let remoteAddr = connection.detail.remoteAddr
                if (remoteAddr.toString().indexOf('/ws/') === -1) {
                    remoteAddr = remoteAddr.toString() + '/ws/p2p/' + connection.detail.remotePeer
                }

                // Pinging node
                console.log(`Pinging remote peer at ${remoteAddr}`)
                const ma = multiaddr(remoteAddr)
                const latency = await node.ping(ma)
                console.log(`Pinged ${remoteAddr} in ${latency}ms`)
                console.log('--')

                // Starting streaming
                startStreaming(node, remoteAddr)
            } catch (e) {
                console.log(e.message)
            }
        })

        // Handle incoming stream
        await node.handle('/echo/1.0.0', async ({ stream }) => {
            // Read the stream and output to console
            streamToConsole(stream)
        }, {
            maxInboundStreams: 4096,
            maxOutboundStreams: 4096
        })

        const stop = async () => {
            // stop libp2p
            await node.stop()
            console.log('libp2p has stopped')
            process.exit(0)
        }
        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
    } catch (e) {
        console.log('--')
        console.log(e.message)
        console.log('--')
    }
}

setTimeout(function () {
    startNode()
}, Math.floor(Math.random() * 1000))