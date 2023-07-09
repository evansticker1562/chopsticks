import * as BlockBuilder from './builder';
import { Blockchain } from "..";
import { BuildBlockParams, EVENT_SUBMIT_DOWNWARD_MESSAGES, EVENT_SUBMIT_EXTRINSIC, EVENT_SUBMIT_HORIZTONAL_MESSAGES, EVENT_SUBMIT_UPWARD_MESSAGES, TxPool } from "../txpool";
import { Deferred, defer } from '../../utils';
import { EventEmitter } from 'node:stream';
import { MinerTimer } from "./miner-timer";
import { defaultLogger } from '../../logger';
import _ from 'lodash';

export enum MinerMode {
  Batch, // one block per batch, default
  Instant, // one block per tx
  Manual, // only build when triggered
  Peroid, // one block per period
}

export interface MinerConfig {
  mode: MinerMode,
  args?: Record<string, any>
}

export const EVENT_APPLY_EXTRINSIC_ERROR = 'TxPool::ApplyExtrinsicError';

const logger = defaultLogger.child({ name: 'block-miner' });

export class BlockMiner {
  public readonly event = new EventEmitter();

  private readonly _minerTimer;
  private readonly _onTxPoolMessageHandler = this._onTxPoolMessage.bind(this);
  private readonly _batchBuildBlockHandler = _.debounce(this._buildBlock, 100, { maxWait: 1000 });
  private readonly _pendingBlocks: { params: BuildBlockParams; deferred: Deferred<void> }[] = [];

  private _isBuilding = false;

  static buildConfigFromArgs(args: any, hasPrefix = false): MinerConfig {
    const config: MinerConfig = {
      mode: MinerMode.Manual,
      args:{}
    };

    const keys = Object.keys(args);
    keys.forEach(key => {
      const value = args[key];
      if (hasPrefix) {
        if (key.indexOf('miner-') != 0) {
          return;
        }
        key = key.substring(6);
      }
      if (key == 'mode') {
        config.mode = parseInt(value) as MinerMode;
      } else {
        config.args![key] = value;
      }
    })
    return config;
  }

  constructor(private readonly _chain: Blockchain, private  _minerConfig: MinerConfig, private readonly _txPool: TxPool) {
    this._setTxPoolListener();
    this._minerTimer = new MinerTimer(this);
    this.resetMiner();
  }

  public resetMiner(): void {
    this._minerTimer.reset();
  }

  public get minerConfig(): MinerConfig {
    return this._minerConfig;
  }

  public set minerConfig(config: MinerConfig) {
    this._minerConfig = config;
    this.resetMiner();
  }

  public async buildBlock(params?: Partial<BuildBlockParams>) {
    const blockFromPool:BuildBlockParams = this._txPool.createNewBlock(params);
    await this.buildBlockWithParams(blockFromPool);
  }

  public async buildBlockWithParams(params: BuildBlockParams) {
    this._pendingBlocks.push({
      params,
      deferred: defer<void>(),
    })
    this._buildBlockIfNeeded()
    await this.upcomingBlocks()
  }

  public async upcomingBlocks() {
    const count = this._pendingBlocks.length
    if (count > 0) {
      await this._pendingBlocks[count - 1].deferred.promise
    }
    return count
  }

  private _setTxPoolListener() {
    this._txPool.event.on(EVENT_SUBMIT_EXTRINSIC, this._onTxPoolMessageHandler);
    this._txPool.event.on(EVENT_SUBMIT_UPWARD_MESSAGES, this._onTxPoolMessageHandler);
    this._txPool.event.on(EVENT_SUBMIT_DOWNWARD_MESSAGES, this._onTxPoolMessageHandler);
    this._txPool.event.on(EVENT_SUBMIT_HORIZTONAL_MESSAGES, this._onTxPoolMessageHandler);
  }

  private _onTxPoolMessage(_event: string, ..._args: any[]) {
    switch (this._minerConfig.mode) {
      case MinerMode.Batch:
        this._batchBuildBlockHandler()
        break
      case MinerMode.Instant:
        this._buildBlock()
        break
      case MinerMode.Manual:
        // does nothing
        break
    }
  }

  private async _buildBlockIfNeeded() {
    if (this._isBuilding) return
    if (this._pendingBlocks.length === 0) return

    this._isBuilding = true
    try {
      await this._buildBlock()
    } finally {
      this._isBuilding = false
    }
    if(this._minerConfig.mode != MinerMode.Peroid) {
      this._buildBlockIfNeeded()
    }
  }

  private async _buildBlock() {
    await this._chain.api.isReady

    const pending = this._pendingBlocks[0]
    if (!pending) {
      throw new Error('Unreachable')
    }
    const { params, deferred } = pending

    logger.trace({ params }, 'build block')

    const head = this._chain.head
    const inherents = await this._chain.getInherentProvider().createInherents(head, params)
    const [newBlock, pendingExtrinsics] = await BlockBuilder.buildBlock(
      head,
      inherents,
      params.transactions,
      params.upwardMessages,
      (extrinsic, error) => {
        this.event.emit(EVENT_APPLY_EXTRINSIC_ERROR, [extrinsic, error])
      }
    )
    for (const extrinsic of pendingExtrinsics) {
      this._txPool.submitExtrinsic(extrinsic);
    }
    await this._chain.setHead(newBlock)

    this._pendingBlocks.shift()
    deferred.resolve()
  }
}
