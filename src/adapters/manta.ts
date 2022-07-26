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

const SUPPORTED_TOKENS: Record<string, number> = {
  KMA: 1,
  KUSD: 9,
  LKSM: 10,
  KSM: 12,
  KAR: 8
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const createBalanceStorages = (api: AnyApi) => {
  return {
    balances: (address: string) =>
      Storage.create<DeriveBalancesAll>({
        api,
        path: 'derive.balances.all',
        params: [address]
      }),
    assets: (id: number, address: string) =>
      Storage.create<any>({
        api,
        path: 'query.assets.account',
        params: [id, address]
      })
  };
};

class MantaBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor ({ api, chain }: BalanceAdapterConfigs) {
    super({ api, chain });
    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance (token: string, address: string): Observable<BalanceData> {
    const storage = this.storages.balances(address);

    if (token === this.nativeToken) {
      return storage.observable.pipe(
        map((data) => ({
          free: FN.fromInner(data.freeBalance.toString(), this.decimals),
          locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
          reserved: FN.fromInner(data.reservedBalance.toString(), this.decimals),
          available: FN.fromInner(data.availableBalance.toString(), this.decimals)
        }))
      );
    }

    const tokenID = SUPPORTED_TOKENS[token];

    if (!tokenID) {
      throw new CurrencyNotFound(token);
    }

    return this.storages.assets(tokenID, address).observable.pipe(
      map((balance) => {
        const amount = FN.fromInner(balance.unwrapOrDefault()?.balance?.toString() || '0', this.getTokenDecimals(token));

        return {
          free: amount,
          locked: new FN(0),
          reserved: new FN(0),
          available: amount
        };
      })
    );
  }
}

class BaseMantaAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: MantaBalanceAdapter;

  public override async setApi (api: AnyApi) {
    this.api = api;

    await api.isReady;

    this.balanceAdapter = new MantaBalanceAdapter({ chain: this.chain.id, api });
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

    const accountId = this.api?.createType('AccountId32', address).toHex();

    const tokenId = SUPPORTED_TOKENS[token];

    if (!tokenId) {
      throw new CurrencyNotFound(token);
    }

    return this.api?.tx.xTokens.transfer(
      { MantaCurrency: tokenId },
      amount.toChainData(),
      {
        V1: {
          parents: 1,
          interior: { X2: [{ Parachain: toChain.paraChainId }, { AccountId32: { id: accountId, network: 'Any' } }] }
        }
      },
      this.getDestWeight(token, to)?.toString());
  }
}

export class CalamariAdapter extends BaseMantaAdapter {
  constructor () {
    super(chains.calamari, routersConfig.calamari);
  }
}