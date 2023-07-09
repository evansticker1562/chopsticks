import { EventEmitter } from 'node:stream'
import { GenericExtrinsic } from '@polkadot/types'
import { HexString } from '@polkadot/util/types'
import _ from 'lodash'

import { Blockchain } from '.'
import { defaultLogger, truncate } from '../logger'

const logger = defaultLogger.child({ name: 'txpool' })

export const EVENT_SUBMIT_EXTRINSIC = 'TxPool::SubmitExtrinsic'
export const EVENT_SUBMIT_UPWARD_MESSAGES = 'TxPool::SubmitUpwardMessages'
export const EVENT_SUBMIT_DOWNWARD_MESSAGES = 'TxPool::SubmitDownwardMessages'
export const EVENT_SUBMIT_HORIZTONAL_MESSAGES = 'TxPool::SubmitHorizontalMessages'

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

export class TxPool {
  readonly #chain: Blockchain

  readonly #pool: { extrinsic: HexString; signer: string }[] = []
  readonly #ump: Record<number, HexString[]> = {}
  readonly #dmp: DownwardMessage[] = []
  readonly #hrmp: Record<number, HorizontalMessage[]> = {}
  readonly event = new EventEmitter()

  constructor(chain: Blockchain) {
    this.#chain = chain
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

  async submitExtrinsic(extrinsic: HexString) {
    logger.debug({ extrinsic: truncate(extrinsic) }, 'submit extrinsic')

    const data = { extrinsic, signer: await this.#getSigner(extrinsic) };
    this.#pool.push(data)

    this.event.emit(EVENT_SUBMIT_EXTRINSIC, data)
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

    this.event.emit(EVENT_SUBMIT_UPWARD_MESSAGES, id, ump)
  }

  submitDownwardMessages(dmp: DownwardMessage[]) {
    logger.debug({ dmp: truncate(dmp) }, 'submit downward messages')

    this.#dmp.push(...dmp)

    this.event.emit(EVENT_SUBMIT_DOWNWARD_MESSAGES, dmp);
  }

  submitHorizontalMessages(id: number, hrmp: HorizontalMessage[]) {
    logger.debug({ id, hrmp: truncate(hrmp) }, 'submit horizontal messages')

    if (!this.#hrmp[id]) {
      this.#hrmp[id] = []
    }
    this.#hrmp[id].push(...hrmp)

    this.event.emit(EVENT_SUBMIT_HORIZTONAL_MESSAGES, id, hrmp);
  }

  createNewBlock(params?: Partial<BuildBlockParams>) {
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
    return {
      transactions,
      upwardMessages,
      downwardMessages,
      horizontalMessages,
    }
  }
}
