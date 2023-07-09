import { afterAll, describe, expect, it, vi  } from 'vitest'

import { setupAll } from './helper'

describe.each([
  { chain: 'Polkadot', endpoint: 'wss://rpc.polkadot.io' },
])('Latest $chain can build blocks', async ({ endpoint }) => {
  const { setup, teardownAll } = await setupAll({ endpoint })

  afterAll(async () => {
    await teardownAll()
  })

  it('set miner mode', async () => {
    const { chain, ws, teardown } = await setup()
    await ws.send('dev_setMinerMode', [3, {
      interval: 12
    }])

    const timeout = async (time) => {
      return new Promise((resolve, reject) => {
        setTimeout(() => resolve(0), time)
      })
    }
    await timeout(50_000);  // cause first build block time larger than 30s
    let blockNumber = chain.head.number;
    await timeout(18_000);
    expect(chain.head.number).eq(blockNumber + 1)

    // change period to 10s
    await ws.send('dev_setMinerMode', [3, {
      interval: 10
    }])

    await timeout(20_000);

    blockNumber = chain.head.number;
    await timeout(15_000);
    expect(chain.head.number).eq(blockNumber + 1)

    // test when set block build mode to Manual
    await ws.send('dev_setMinerMode', [2])
    await timeout(10_000);
    blockNumber = chain.head.number;
    await timeout(20_000);
    expect(chain.head.number).eq(blockNumber)

    await teardown();
  })
})
