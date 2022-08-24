# Examples of a p2p network using libp2p

Working on some p2p networks for other projects and wanted to make some tests with libp2p. This test will allow you create a network of `n` nodes that will exchange random data. You will see how many data are exchanged, messages etc.

## Dependencies

First install dependencies with:
```
yarn
```
## Stream version
Then can test two versions `stream` and `pubsub` one, just open several terminals and create nodes with:

```
yarn dev:stream <NODE_NAME>
```

Please use a number as `<NODE_NAME>` and I suggest to create at least 3 nodes, so:

```
yarn dev:stream 1
yarn dev:stream 2
yarn dev:stream 3
```

After everything is setted up you should see something like this:
![Test](./test.png "Test")

## PubSub version

Working also on the pubsub version to compare performances.

```
yarn dev:pubsub <NODE_NAME>
```

Note, `pubsub` version is not working at the moment.