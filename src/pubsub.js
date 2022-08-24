import process from 'node:process'
import { createLibp2p } from 'libp2p'
import { WebSockets } from '@libp2p/websockets'
import { Noise } from '@chainsafe/libp2p-noise'
import { Mplex } from '@libp2p/mplex'
import { multiaddr } from 'multiaddr'
import { Bootstrap } from '@libp2p/bootstrap'
import { GossipSub } from '@chainsafe/libp2p-gossipsub'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import * as lp from 'it-length-prefixed'
import map from 'it-map'
import { pipe } from 'it-pipe'
import fs from 'fs'
import _ from 'lodash'
import crypto from 'crypto'

let started = false
let starting = false
const topic = 'news'

function startPublish(node) {
    const interval = setInterval(
        async function () {
            try {
                const bytes = _.random(1, 64, 0)
                crypto.randomBytes(bytes, async (err, buffer) => {
                    if (err) {
                        // Prints error
                        console.log(err);
                        return;
                    }
                    const message = '[' + new Date().getTime() + '] [' + process.argv[2] + '] ' + buffer.toString('hex')
                    await node.pubsub.publish(topic, uint8ArrayFromString(message))
                });
            } catch (e) {
                console.log("[PUBLISH FAILED] stopping publish to peer.")
                console.log(e.message)
                clearInterval(interval)
                setTimeout(function () {
                    started = false
                    startNode()
                }, 100)
            }
        }
        , 1000)
}

function returnBootstrappers() {
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
    return bootstrapers
}

async function startNode() {
    if (!starting && !started) {
        starting = true
        // Taking bootstrap nodes
        const bootstrapers = returnBootstrappers()

        // Creating node
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
                pubsub: new GossipSub({
                    emitSelf: true
                }),
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
            // Handle peer connection
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
                } catch (e) {
                    console.log("[ERROR PINGING]", e.message)
                }
            })

            // Listen to pubsub topics
            node.pubsub.addEventListener(topic, (msg) => {
                console.log(`> ${toString(msg.data)}`)
            })
            await node.pubsub.subscribe(topic)
            startPublish(node)

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