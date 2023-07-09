import { BlockMiner, MinerMode } from "./miner";
import { defaultLogger } from '../../logger'

const DEFAULT_BUILD_PERIOD = 12;

const logger = defaultLogger.child({ name: 'block-miner-timer' })

export class MinerTimer {
  private _timer: NodeJS.Timer | null = null;
  private _interval: number = DEFAULT_BUILD_PERIOD;

  constructor(private readonly _miner: BlockMiner) {}

  public reset() {
    this.stop();

    const minerConfig = this._miner.minerConfig;
    if (minerConfig.mode == MinerMode.Peroid) {
      this.start();
    }
  }

  public start() {
    const minerConfig = this._miner.minerConfig;
    const args = minerConfig.args;

    if (!args?.interval
      || isNaN(args.interval)
      ||  args.interval <= 0) {
      this._interval = DEFAULT_BUILD_PERIOD;
    } else {
      this._interval = args.interval
    }

    this._timer = setInterval(() => {
      logger.info(`Start building block.., interval:${this._interval}`)
      this._miner.buildBlock();
    }, this._interval * 1000)
  }

  public stop() {
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
