const log = require('loglevel')
const ObservableStore = require('obs-store')

const connext = require('@connext/client')

class ChannelController {
  /**
   * @constructor
   * @param {Object} opts
   */
  constructor(opts) {
    const initState = {
      channel: undefined,
      links: []
    }
    this.store = new ObservableStore(initState)
    this.networkController = opts.networkController
    this.keyringController = opts.keyringController
  }

  /**
   * Helper method for initializing the connext client.
   *
   * This should be called any time on app startup, or before
   * using any channel methods.
   *
   * @returns Promise<void>
   */
  initializeConnext() {
    const { LOG_LEVEL } = process.env

    const xpub = this.keyringController.getChannelXPub()
    const keyGen = this.keyringController.getChannelKeyGen()

    const network = this.networkController.store.getFlatState().network
    if (!['mainnet', 'rinkeby'].includes(network)) {
      log.error(`Channel can't be initialized with network: ${network}`)
      return
    }

    log.debug('Initializing Channel...')
    connext
      .connect(network, {
        xpub,
        keyGen,
        logLevel: LOG_LEVEL || 5 // default to log everything
      })
      .then(channel => {
        log.debug('Channel Connected!')
        this.saveChannel(channel)
      })
      .catch(error => log.error(error))
  }

  ///////////////////////////////////////////
  //// Core channel methods

  /**
   * Deposit into the channel.
   * @param {string} amount wei to deposit into channel
   * @param {string?} assetId token address to deposit (defaults to ETH)
   */
  deposit(amount, assetId) {
    const channel = this.getChannel()
    return channel.deposit({
      amount,
      assetId
    })
  }

  /**
   * Perform in channel swap/exchange at given swap rate.
   * @param {string} amount wei to swap of fromAssetId
   * @param {string} swapRate swap rate in
   */
  swap(amount, swapRate, toAssetId, fromAssetId) {
    const channel = this.getChannel()
    return channel.swap({
      amount,
      swapRate,
      toAssetId,
      fromAssetId
    })
  }

  /**
   * Create a linked payment that is redeemable by anyone.
   * Should save the generated paymentId and preImage to send
   * or allow to be redeemable.
   *
   * @param {string} amount wei to send of assetId
   * @param {string?} assetId asset to send, defaults to eth
   */
  linkTransfer(amount, assetId) {
    const channel = this.getChannel()
    const paymentId = connext.utils.createPaymentId()
    const preImage = connext.utils.createPreImage()
    return channel
      .conditionalTransfer({
        assetId,
        amount,
        conditionType: 'LINKED_TRANSFER',
        paymentId: connext.utils.createPaymentId(),
        preImage: connext.utils.createPreImage()
      })
      .then(transfer => this.saveLinkInfo(paymentId, preImage))
  }

  /**
   * Creates an async payment to a recipient.
   *
   * @param {string} amount wei to send of assetId
   * @param {string} recipient payee's xpub
   * @param {string?} assetId asset to send, defaults to eth
   */
  transfer(amount, recipient, assetId) {
    const channel = this.getChannel()
    return channel.conditionalTransfer({
      assetId,
      amount,
      conditionType: 'LINKED_TRANSFER_TO_RECIPIENT',
      paymentId: connext.utils.createPaymentId(),
      preImage: connext.utils.createPreImage(),
      recipient
    })
  }

  /**
   * Perform in channel swap/exchange at given swap rate.
   * @param {string} amount wei to withdraw of assetId
   * @param {string?} recipient address to withdraw to, should be accounts[0],
   * but will default to channel.freeBalanceAddress
   * @param {string?} assetId asset to withdraw, defaults to eth
   */
  withdraw(amount, recipient, assetId) {
    const channel = this.getChannel()
    return channel.withdraw({
      amount,
      recipient,
      assetId
    })
  }

  /**
   * Returns the balance available to spend in the channel as an obj.
   *
   * To access user's available free balance:
   * const userFb = channel.getFreeBalance(assetId)
   *  .then(fb => fb[channel.freeBalanceAddress])
   *
   * @param {string?} assetId Address of asset you want balance of, defaults to ETH
   */
  getFreeBalance(assetId) {
    const channel = this.getChannel()
    return channel.getFreeBalance(assetId)
  }

  ///////////////////////////////////////////
  //// Getters / setters
  saveChannel(channel) {
    return this.store.updateState({ channel })
  }

  saveLinkInfo(paymentId, preImage) {
    const links = this.store.getState().links || []
    links.push({ paymentId, preImage })
    return this.store.updateState({ links })
  }

  getChannel() {
    const channel = this.store.getState().channel
    if (!channel) {
      throw new Error('Channel has not been initialized, call initializeConnext')
      return
    }
    return channel
  }

  /**
   * A method for serving our channel provider over a given stream.
   * @param {*} channelMux - The stream to provide over.
   */
  setupChannelRpcStream(channelMux) {
    this.channelRpcStream = channelMux.getStream('channel_rpc')

    this.channelRpcStream.on('data', payload => this.onPayload(payload))
  }

  async onPayload(payload) {
    const channel = this.getChannel()

    const { params, id, method } = payload

    verifyPayload(payload)

    let errorMsg
    let result

    try {
      result = await channel.channelProvider.send(method, params)
    } catch (e) {
      errorMsg = `ChannelProvider error: ${JSON.stringify(e, null, 2)}`
    }

    if (result) {
      channelRpcStream.write({ id, result })
    } else {
      channelRpcStream.write({ id, error: { message: errorMsg || 'ChannelProvider error: Missing error message' } })
      log.error(errorMsg)
    }
  }
}

// util

function prettyPrint(obj) {
  return JSON.stringify(obj, null, 2)
}

function verifyPayload(payload) {
  if (!params || typeof params !== 'object') {
    throw new Error(`Invalid payload params. Payload: ${prettyPrint(payload)}`)
  }

  if (!id) {
    throw new Error(`Invalid payload id. Payload: ${prettyPrint(payload)}`)
  }

  if (!method || typeof method !== 'string') {
    throw new Error(`Invalid payload method. Payload: ${prettyPrint(payload)}`)
  }
}

export default ChannelController
