import { Storage } from '@acala-network/sdk/utils/storage';
import { AnyApi, FixedPointNumber as FN } from '@acala-network/sdk-core';
import { combineLatest, map, Observable } from 'rxjs';

import { SubmittableExtrinsic } from '@polkadot/api/types';
import { DeriveBalancesAll } from '@polkadot/api-derive/balances/types';
import { ISubmittableResult } from '@polkadot/types/types';

import { BalanceAdapter, BalanceAdapterConfigs } from '../balance-adapter';
import { BaseCrossChainAdapter } from '../base-chain-adapter';
import { ChainName, chains, routersConfig } from '../configs';
import { ApiNotFound, CurrencyNotFound } from '../errors';
import { BalanceData, CrossChainTransferParams } from '../types';

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const createBalanceStorages = (api: AnyApi) => {
  return {
    balances: (address: string) =>
      Storage.create<DeriveBalancesAll>({
        api,
        path: 'derive.balances.all',
        params: [address]
      })
  };
};

class CrustBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor ({ api, chain }: BalanceAdapterConfigs) {
    super({ api, chain });
    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance (token: string, address: string): Observable<BalanceData> {
    const storage = this.storages.balances(address);

    if (token !== this.nativeToken) {
      throw new CurrencyNotFound(token);
    }

    return storage.observable.pipe(
      map((data) => ({
        free: FN.fromInner(data.freeBalance.toString(), this.decimals),
        locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
        reserved: FN.fromInner(data.reservedBalance.toString(), this.decimals),
        available: FN.fromInner(data.availableBalance.toString(), this.decimals)
      }))
    );
  }
}

class BaseCrustAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: CrustBalanceAdapter;

  public override async setApi (api: AnyApi) {
    this.api = api;

    await api.isReady;

    this.balanceAdapter = new CrustBalanceAdapter({ chain: this.chain.id, api });
  }

  public subscribeTokenBalance (token: string, address: string): Observable<BalanceData> {
    if (!this.balanceAdapter) {
      return new Observable((sub) =>
        sub.next({
          free: FN.ZERO,
          locked: FN.ZERO,
          available: FN.ZERO,
          reserved: FN.ZERO
        })
      );
    }

    return this.balanceAdapter.subscribeBalance(token, address);
  }

  public subscribeMaxInput (token: string, address: string, to: ChainName): Observable<FN> {
    if (!this.balanceAdapter) {
      return new Observable((sub) => sub.next(FN.ZERO));
    }

    return combineLatest({
      txFee:
        token === this.balanceAdapter?.nativeToken
          ? this.estimateTxFee(
            {
              amount: FN.ZERO,
              to,
              token,
              address,
              signer: address
            }

          )
          : '0',
      balance: this.balanceAdapter.subscribeBalance(token, address).pipe(map((i) => i.available)),
      ed: this.balanceAdapter?.getTokenED(token)
    }).pipe(
      map(({ balance, ed, txFee }) => {
        const feeFactor = 1.2;
        const fee = FN.fromInner(txFee, this.balanceAdapter?.getTokenDecimals(token)).mul(new FN(feeFactor));

        // always minus ed
        return balance.minus(fee).minus(ed || FN.ZERO);
      })
    );
  }

  public createTx (params: CrossChainTransferParams): SubmittableExtrinsic<'promise', ISubmittableResult> | SubmittableExtrinsic<'rxjs', ISubmittableResult> {
    if (this.api === undefined) {
      throw new ApiNotFound(this.chain.id);
    }

    const { address, amount, to, token } = params;
    const toChain = chains[to];

    if (token !== this.balanceAdapter?.nativeToken) {
      throw new CurrencyNotFound(token);
    }

    const accountId = this.api?.createType('AccountId32', address).toHex();

    const dst = { X2: ['Parent', { ParaChain: toChain.paraChainId }] };
    const acc = { X1: { AccountId32: { id: accountId, network: 'Any' } } };
    const ass = [{ ConcreteFungible: { amount: amount.toChainData() } }];

    return this.api?.tx.polkadotXcm.limitedReserveTransferAssets({ V0: dst }, { V0: acc }, { V0: ass }, 0, this.getDestWeight(token, to)?.toString());
  }
}

export class ShadowAdapter extends BaseCrustAdapter {
  constructor () {
    super(chains.shadow, routersConfig.shadow);
  }
}