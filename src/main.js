const ProviderEngine = require('web3-provider-engine')
const CacheSubprovider = require('web3-provider-engine/subproviders/cache.js')
const FixtureSubprovider = require('web3-provider-engine/subproviders/fixture.js')
const FilterSubprovider = require('web3-provider-engine/subproviders/filters.js')
const VmSubprovider = require('web3-provider-engine/subproviders/vm.js')
const HookedWalletEthTxSubprovider = require('web3-provider-engine/subproviders/hooked-wallet-ethtx.js')
const NonceSubprovider = require('web3-provider-engine/subproviders/nonce-tracker.js')
const RpcSubprovider = require('web3-provider-engine/subproviders/rpc.js')
const Web3 = require('web3')
const createEngineStream = require('json-rpc-middleware-stream/engineStream')
const pump = require('pump')
const setupMultiplex = require('./stream-utils.js').setupMultiplex
// const ObservableStore = require('obs-store')
const RpcEngine = require('json-rpc-engine')
const createFilterMiddleware = require('eth-json-rpc-filters')
const log = require('loglevel')
// const DuplexStream = require('readable-stream').Duplex
const stream = require('stream')

function buf2hex(buffer) { // buffer is an ArrayBuffer
  return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
}

function eventFire(el, etype){
  if (el.fireEvent) {
    el.fireEvent('on' + etype);
  } else {
    var evObj = window.document.createEvent('Events');
    evObj.initEvent(etype, true, false);
    el.dispatchEvent(evObj);
  }
}

var engine = new ProviderEngine()
engine.addProvider(new FixtureSubprovider({
  web3_clientVersion: 'ProviderEngine/v0.0.0/javascript',
  net_listening: true,
  eth_hashrate: '0x00',
  eth_mining: false,
  eth_syncing: true,
}))
engine.addProvider(new CacheSubprovider())
engine.addProvider(new FilterSubprovider())
engine.addProvider(new NonceSubprovider())
engine.addProvider(new VmSubprovider())
engine.addProvider(new HookedWalletEthTxSubprovider({
  getAccounts: function(cb) {
    // cb(null, ['0x5657d2e6D362618Fb0DA4b90aa6e22eD86e30bfd'])
    // console.log(window.ethAddress, 'ethadd')
    var ethAddress = sessionStorage.getItem('ethAddress')

    // TODO: checksumAddress
    cb(null, ethAddress ? [Web3.utils.toChecksumAddress(ethAddress)] : [])
    // cb(null, ethAddress ? [ethAddress] : [])
  },
  getPrivateKey: function(address, cb) {
    var address = Web3.utils.toChecksumAddress(address)
    var wallet = JSON.parse(sessionStorage.getItem("wallet"))
    if (wallet == null) {
      cb(new Error("No wallet accessible. Please login."), null)
      return
    }
    if (address == null) {
      cb(new Error("No address given."), null)
      return
    } else if (wallet[address] == null) {
      cb(new Error("No private key accessible. Please login."), null)
      return
    } else {
      console.log('PRIVATE KEY RETRIEVED...')
      cb(null, Buffer(wallet[address], 'hex'))
    }
  },
  approveTransaction: function(txParams, cb) {
    if (txParams.withGasPrice) {
      window.communicationStream.write({name: "completeTransaction", data: {}});
      if(confirm('Confirm signature for transaction?')) {
        cb(null, true)
      } else {
        cb(new Error('User denied transaction.'), false)
      }
    } else if (txParams.denyTransaction) {
      if (txParams.completed) {
        cb(null, false);
      } else {
        window.communicationStream.write({name: "denyTransaction", data: {
            params: txParams
        }});
      }
    }
  }
}))
var rpcSource = new RpcSubprovider({
  rpcUrl: 'https://mainnet.infura.io/4cQUeyeUSfkCXsgEAUH2',
  // rpcUrl: 'http://localhost:7545'
})
engine.addProvider(rpcSource)
engine.on('block', function(block){
  console.log('================================')
  console.log('BLOCK CHANGED:', '#'+block.number.toString('hex'), '0x'+block.hash.toString('hex'))
  console.log('================================')
})
engine.on('error', function(err){
  console.error(err.stack)
})
engine.start()
  window.web3 = new Web3(engine)



/* 
 * Set up window.postMessage relay of 
 * the provider we have created above
 */

const LocalMessageDuplexStream = require('post-message-stream')
window.LocalMessageDuplexStream = LocalMessageDuplexStream
// we set up a Window.postMessage() stream between localhost:3000 context (iframe) and the dapp inpage context (embed)
window.metamaskStream = new LocalMessageDuplexStream({
  name: 'iframe_metamask',
  target: 'embed_metamask',
  targetWindow: window.parent
})
window.communicationStream = new LocalMessageDuplexStream({
  name: 'iframe_comm',
  target: 'embed_comm',
  targetWindow: window.parent
})

// taken from metamask...
const rpcEngine = new RpcEngine()
const providerStream = createEngineStream({engine: rpcEngine})
const filterMiddleware = createFilterMiddleware({
  provider: engine,
  blockTracker: engine._blockTracker,
})
rpcEngine.push(createOriginMiddleware({ origin: 'torus' }))
rpcEngine.push(createLoggerMiddleware({ origin: 'torus' }))
rpcEngine.push(filterMiddleware)
rpcEngine.push(createProviderMiddleware({ provider: engine }))


// this allows us to set up multiple channels using just a single stream connection
const metamaskMux = setupMultiplex(window.metamaskStream)
const commMux = setupMultiplex(window.communicationStream)

// define channels within a stream
const providerOutStream = metamaskMux.createStream('provider')
const publicConfigOutStream = metamaskMux.createStream('publicConfig')
const oauthInputStream = commMux.createStream('oauth')
const p = new stream.PassThrough({objectMode: true});

p.on('data', function() {
  console.log('p data:', arguments)
  eventFire(window.document.getElementById("googleAuthBtn"), "click")
})

pump(oauthInputStream, p, (err) => {
  if (err) log.error(err)
})

function updateSelectedAddress() {
  web3.eth.getAccounts().then(res => {
    console.log('updateSelectedaddress', res[0])
    // TODO: checksum address
    publicConfigOutStream.write(JSON.stringify({selectedAddress: res[0] || null}))
  }).catch(err => log.error(err))
}

function updateSelectedNetwork() {
  web3.eth.net.getId().then(res => {
    publicConfigOutStream.write(JSON.stringify({networkVersion: res}))
  }).catch(err => log.error(err))
}

// account address data and network data is "static" because the dapp inpage context is going to request for it in a synchronous manner
// as such, we proactively update the inpage context with these data
window.updateStaticDataInIFrame = function() {
  updateSelectedNetwork()
  updateSelectedAddress()
}

window.updateStaticDataInIFrame()

var receivePassThroughStream = new stream.PassThrough({objectMode: true});
receivePassThroughStream.on('data', function() {
  console.log('receivePassThroughStream', arguments)
})

// ethereumjs-vm uses ethereumjs-tx/fake.js to create a fake transaction
// and it expects tx.from to be a Buffer that is used for signing and stuff.
// the problem is that after passing our messages through a bunch of providers
// the tx.from field becomes a hex string. Here we convert it back to Buffer.
// this only affects eth_call
var transformStream = new stream.Transform({
  objectMode: true,
  transform: function(chunk, enc, cb) {
    console.log('TRANSFORM', chunk)

    if (chunk.method === 'eth_sendTransaction') {
      if (chunk.params[0].withGasPrice || chunk.params[0].denyTransaction) {
        chunk.id = chunk.params[0].id;
        cb(null, chunk);
      } else {
        window.communicationStream.write({name: "approveTransactionDisplay", data: {
          website: document.referrer,
          params: chunk.params[0]
        }})
        cb(null, chunk);
      }
    } else {
      try {
        if (chunk.method === 'eth_call' || chunk.method === 'eth_estimateGas') {
          console.log('transforming:', chunk.params[0].from)
          if (chunk.params[0].from && typeof chunk.params[0].from === "string") {
            if (chunk.params[0].from.substring(0,2) == '0x') {
              chunk.params[0].from = Buffer.from(chunk.params[0].from.slice(2), 'hex');
            }
          } else if (!chunk.params[0].from) {
            chunk.params[0].from = []
          }
          console.log('transformed:', chunk.params[0].from)
        }
      } catch (err) {
        console.error("Could not transform stream data", err)
      }
      cb(null, chunk)
    }
  }
})

// doesnt do anything.. just for logging
// since the stack traces are constrained to a single javascript context
// may need to use a passthrough stream to log stuff between streams
var sendPassThroughStream = new stream.PassThrough({objectMode: true});
sendPassThroughStream.on('data', function() {
  console.log('sendPassThroughStream', arguments)
})

// chaining all the streams together
pump(
  providerOutStream,
  sendPassThroughStream,
  transformStream,
  providerStream,
  receivePassThroughStream,
  providerOutStream,
  (err) => {
    if (err) log.error(err)
  }
)

// taken from metamask
function createOriginMiddleware (opts) {
  return function originMiddleware (req, res, next) {
    req.origin = opts.origin
    next()
  }
}

function createLoggerMiddleware (opts) {
  return function loggerMiddleware (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) {
    next((/** @type {Function} */ cb) => {
      if (res.error) {
        log.error('Error in RPC response:\n', res)
      }
      if (req.isMetamaskInternal) return
      log.info(`RPC (${opts.origin}):`, req, '->', res)
      cb()
    })
  }
}

function createProviderMiddleware ({ provider }) {
  return (req, res, next, end) => {
    provider.sendAsync(req, (err, _res) => {
      if (err) return end(err)
      res.result = _res.result
      end()
    })
  }
}
