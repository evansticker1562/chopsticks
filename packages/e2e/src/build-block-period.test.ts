import { afterAll, describe, expect, it, vi  } from 'vitest'

import { setupAll } from './helper'

describe.each([
  { chain: 'Polkadot', endpoint: 'wss://rpc.polkadot.io' },
])('Latest $chain can build blocks', async ({ endpoint }) => {
  const { setup, teardownAll } = await setupAll({ endpoint })

  afterAll(async () => {
    await teardownAll()
  })

  it('build block period', async () => {
    const { chain, ws, teardown } = await setup()
    await ws.send('dev_setBlockBuildModeArgs', [{
      period: 12
    }])
    await ws.send('dev_setBlockBuildMode', [3])

    const timeout = async (time) => {
      return new Promise((resolve, reject) => {
        setTimeout(() => resolve(0), time)
      })
    }
    await timeout(50_000);  // cause first build block time larger than 30s
    let blockNumber = chain.head.number;
    await timeout(12_000);
    expect(chain.head.number).eq(blockNumber + 1)

    // change period to 10s
    await ws.send('dev_setBlockBuildModeArgs', [{
      period: 10
    }])
    await ws.send('dev_setBlockBuildMode', [3])
    await timeout(20_000);

    blockNumber = chain.head.number;
    await timeout(10_000);
    expect(chain.head.number).eq(blockNumber + 1)

    // test when set block build mode to Manual
    await ws.send('dev_setBlockBuildMode', [2])
    await timeout(10_000);
    blockNumber = chain.head.number;
    await timeout(10_000);
    expect(chain.head.number).eq(blockNumber)

    await teardown();
  })
})
