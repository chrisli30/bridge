import { BN } from '@polkadot/util';

import { CrossChainRouterConfigs, FN } from '../../types';

export const turingRoutersConfig: Record<string, Omit<CrossChainRouterConfigs, 'from'>[]> = {
  turing: [
    { to: 'karura', token: 'TUR', xcm: { fee: { token: 'TUR', balance: FN.fromInner('2560000000', 10) }, weightLimit: new BN(5_000_000_000) } }
  ]
  // turing: {
  //   TUR: { fee: '1664000000', existentialDeposit: '100000000', decimals: 10 },
  //   KAR: { fee: '32000000000', existentialDeposit: '100000000000', decimals: 12 },
  //   KUSD: { fee: '256000000000', existentialDeposit: '10000000000', decimals: 12 },
  //   LKSM: { fee: '6400000000', existentialDeposit: '500000000', decimals: 12 }
  // }
};
