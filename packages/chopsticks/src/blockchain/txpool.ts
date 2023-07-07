import { EventEmitter } from 'node:stream'
import { GenericExtrinsic } from '@polkadot/types'
import { HexString } from '@polkadot/util/types'
import _ from 'lodash'

import { Blockchain } from '.'
import { Deferred, defer } from '../utils'
import { InherentProvider } from './inherent'
import { buildBlock } from './block-builder'
import { defaultLogger, truncate } from '../logger'

const logger = defaultLogger.child({ name: 'txpool' })

export const APPLY_EXTRINSIC_ERROR = 'TxPool::ApplyExtrinsicError'

export enum BuildBlockMode {
  Batch, // one block per batch, default
  Instant, // one block per tx
  Manual, // only build when triggered
  Peroid, // one block per period
}

export interface BuildBlockModeArgs {
  period?: number
}

export interface DownwardMessage {
  sentAt: number
  msg: HexString
}

export interface HorizontalMessage {
  sentAt: number
  data: HexString
}

export interface BuildBlockParams {
  downwardMessages: DownwardMessage[]
  upwardMessages: Record<number, HexString[]>
  horizontalMessages: Record<number, HorizontalMessage[]>
  transactions: HexString[]
}

const DEFAULT_BUILD_PERIOD = 12;

export class TxPool {
  readonly #chain: Blockchain

  readonly #pool: { extrinsic: HexString; signer: string }[] = []
  readonly #ump: Record<number, HexString[]> = {}
  readonly #dmp: DownwardMessage[] = []
  readonly #hrmp: Record<number, HorizontalMessage[]> = {}

  #mode: BuildBlockMode
  #modeArgs: BuildBlockModeArgs
  readonly #inherentProvider: InherentProvider
  readonly #pendingBlocks: { params: BuildBlockParams; deferred: Deferred<void> }[] = []

  readonly event = new EventEmitter()

  #isBuilding = false

  #blockTimer: NodeJS.Timer | null = null;

  constructor(chain: Blockchain, inherentProvider: InherentProvider, mode: BuildBlockMode = BuildBlockMode.Batch, modeArgs: BuildBlockModeArgs = {}) {
    this.#chain = chain
    this.#mode = mode
    this.#modeArgs = modeArgs || {}
    this.#inherentProvider = inherentProvider
    this.setupBlockMode();
  }

  get pendingExtrinsics(): HexString[] {
    return this.#pool.map(({ extrinsic }) => extrinsic)
  }

  get ump(): Record<number, HexString[]> {
    return this.#ump
  }

  get dmp(): DownwardMessage[] {
    return this.#dmp
  }

  get hrmp(): Record<number, HorizontalMessage[]> {
    return this.#hrmp
  }

  get mode(): BuildBlockMode {
    return this.#mode
  }

  set mode(mode: BuildBlockMode) {
    this.#mode = mode
    this.setupBlockMode();
  }

  get modeArgs(): BuildBlockModeArgs {
    return this.#modeArgs
  }

  set modeArgs(modeArgs: BuildBlockModeArgs) {
    this.#modeArgs = modeArgs || {}
  }

  clear() {
    this.#pool.length = 0
    for (const id of Object.keys(this.#ump)) {
      delete this.#ump[id]
    }
    this.#dmp.length = 0
    for (const id of Object.keys(this.#hrmp)) {
      delete this.#hrmp[id]
    }
  }

  pendingExtrinsicsBy(address: string): HexString[] {
    return this.#pool.filter(({ signer }) => signer === address).map(({ extrinsic }) => extrinsic)
  }

  setupBlockMode() {
    // clear block build mode firstly
    this.clearBlockMode();

    // setup block build mode
    switch (this.#mode) {
      case BuildBlockMode.Peroid:
        this.setupPeroidBlockMode();
        break
      default:
        break
    }
  }

  clearBlockMode() {
    if (this.#mode != BuildBlockMode.Peroid) {
      this.clearPeriodBlockMode();
    }
  }

  clearPeriodBlockMode() {
    // clear block build period timer
    if (this.#blockTimer) {
      clearInterval(this.#blockTimer);
      this.#blockTimer = null;
    }
  }

  setupPeroidBlockMode() {
    // check arguments
    if (!this.#modeArgs.period
      || isNaN(this.#modeArgs.period)
      ||  this.#modeArgs.period <= 0) {
      this.#modeArgs.period = DEFAULT_BUILD_PERIOD;
    }

    this.clearPeriodBlockMode();

    logger.info(`setupPeroidBlockMode, period:${this.#modeArgs.period}`)
    // build new block per peroid
    this.#blockTimer = setInterval(() => {
      logger.info(`Start build block.., interval:${this.#modeArgs.period}`)
      this.buildBlock();
    }, this.#modeArgs.period * 1000)
  }

  async submitExtrinsic(extrinsic: HexString) {
    logger.debug({ extrinsic: truncate(extrinsic) }, 'submit extrinsic')

    this.#pool.push({ extrinsic, signer: await this.#getSigner(extrinsic) })

    this.#maybeBuildBlock()
  }

  async #getSigner(extrinsic: HexString) {
    const registry = await this.#chain.head.registry
    const tx = registry.createType<GenericExtrinsic>('GenericExtrinsic', extrinsic)
    return tx.signer.toString()
  }

  submitUpwardMessages(id: number, ump: HexString[]) {
    logger.debug({ id, ump: truncate(ump) }, 'submit upward messages')

    if (!this.#ump[id]) {
      this.#ump[id] = []
    }
    this.#ump[id].push(...ump)

    this.#maybeBuildBlock()
  }

  submitDownwardMessages(dmp: DownwardMessage[]) {
    logger.debug({ dmp: truncate(dmp) }, 'submit downward messages')

    this.#dmp.push(...dmp)

    this.#maybeBuildBlock()
  }

  submitHorizontalMessages(id: number, hrmp: HorizontalMessage[]) {
    logger.debug({ id, hrmp: truncate(hrmp) }, 'submit horizontal messages')

    if (!this.#hrmp[id]) {
      this.#hrmp[id] = []
    }
    this.#hrmp[id].push(...hrmp)

    this.#maybeBuildBlock()
  }

  #maybeBuildBlock() {
    switch (this.#mode) {
      case BuildBlockMode.Batch:
        this.#batchBuildBlock()
        break
      case BuildBlockMode.Instant:
        this.buildBlock()
        break
      case BuildBlockMode.Manual:
        // does nothing
        break
      case BuildBlockMode.Peroid:
        // does nothing
        break
    }
  }

  #batchBuildBlock = _.debounce(this.buildBlock, 100, { maxWait: 1000 })

  async buildBlockWithParams(params: BuildBlockParams) {
    this.#pendingBlocks.push({
      params,
      deferred: defer<void>(),
    })
    this.#buildBlockIfNeeded()
    await this.upcomingBlocks()
  }

  async buildBlock(params?: Partial<BuildBlockParams>) {
    const transactions = params?.transactions || this.#pool.splice(0).map(({ extrinsic }) => extrinsic)
    const upwardMessages = params?.upwardMessages || { ...this.#ump }
    const downwardMessages = params?.downwardMessages || this.#dmp.splice(0)
    const horizontalMessages = params?.horizontalMessages || { ...this.#hrmp }
    if (!params?.upwardMessages) {
      for (const id of Object.keys(this.#ump)) {
        delete this.#ump[id]
      }
    }
    if (!params?.horizontalMessages) {
      for (const id of Object.keys(this.#hrmp)) {
        delete this.#hrmp[id]
      }
    }
    await this.buildBlockWithParams({
      transactions,
      upwardMessages,
      downwardMessages,
      horizontalMessages,
    })
  }

  async upcomingBlocks() {
    const count = this.#pendingBlocks.length
    if (count > 0) {
      await this.#pendingBlocks[count - 1].deferred.promise
    }
    return count
  }

  async #buildBlockIfNeeded() {
    if (this.#isBuilding) return
    if (this.#pendingBlocks.length === 0) return

    this.#isBuilding = true
    try {
      await this.#buildBlock()
    } finally {
      this.#isBuilding = false
    }
    this.#buildBlockIfNeeded()
  }

  async #buildBlock() {
    await this.#chain.api.isReady

    const pending = this.#pendingBlocks[0]
    if (!pending) {
      throw new Error('Unreachable')
    }
    const { params, deferred } = pending

    logger.trace({ params }, 'build block')

    const head = this.#chain.head
    const inherents = await this.#inherentProvider.createInherents(head, params)
    const [newBlock, pendingExtrinsics] = await buildBlock(
      head,
      inherents,
      params.transactions,
      params.upwardMessages,
      (extrinsic, error) => {
        this.event.emit(APPLY_EXTRINSIC_ERROR, [extrinsic, error])
      }
    )
    for (const extrinsic of pendingExtrinsics) {
      this.#pool.push({ extrinsic, signer: await this.#getSigner(extrinsic) })
    }
    await this.#chain.setHead(newBlock)

    this.#pendingBlocks.shift()
    deferred.resolve()
  }
}
