import { Storage } from "@acala-network/sdk/utils/storage";
import { AnyApi, FixedPointNumber as FN } from "@acala-network/sdk-core";
import { combineLatest, map, Observable } from "rxjs";

import { SubmittableExtrinsic } from "@polkadot/api/types";
import { DeriveBalancesAll } from "@polkadot/api-derive/balances/types";
import { ISubmittableResult } from "@polkadot/types/types";

import { BalanceAdapter, BalanceAdapterConfigs } from "../balance-adapter";
import { BaseCrossChainAdapter } from "../base-chain-adapter";
import { ChainId, chains } from "../configs";
import { ApiNotFound, InvalidAddress, TokenNotFound } from "../errors";
import { BalanceData, ExtendedToken, TransferParams } from "../types";
import { validateAddress, createRouteConfigs, createPolkadotXCMDest, createPolkadotXCMAccount, createPolkadotXCMAsset } from "../utils";

type TokenData = ExtendedToken & { toQuery: () => string };

export const astarTokensConfig: Record<string, Record<string, TokenData>> = {
  astar: {
    ASTR: {
      name: "ASTR",
      symbol: "ASTR",
      decimals: 18,
      ed: "1000000",
    } as TokenData,
    ACA: {
      name: "ACA",
      symbol: "ACA",
      decimals: 12,
      ed: "1",
      toRaw: () => "0x0000000000000000000000000000000000000000000000000000000000000000",
      toQuery: () => "18446744073709551616",
    },
    AUSD: {
      name: "AUSD",
      symbol: "AUSD",
      decimals: 12,
      ed: "1",
      toRaw: () => "0x0001000000000000000000000000000000000000000000000000000000000000",
      toQuery: () => "18446744073709551617",
    },
    LDOT: {
      name: "LDOT",
      symbol: "LDOT",
      decimals: 10,
      ed: "1",
      toRaw: () => "0x0003000000000000000000000000000000000000000000000000000000000000",
      toQuery: () => "18446744073709551618",
    },
  },
  shiden: {
    SDN: {
      name: "SDN",
      symbol: "SDN",
      decimals: 18,
      ed: "1000000",
    } as TokenData,
    KUSD: {
      name: "KUSD",
      symbol: "KUSD",
      decimals: 12,
      ed: "1",
      toRaw: () => "0x0081000000000000000000000000000000000000000000000000000000000000",
      toQuery: () => "18446744073709551616",
    },
  },
  shibuya: {
    SBY: {
      name: "SBY",
      symbol: "SBY",
      decimals: 18,
      ed: "1000000",
    } as TokenData,
    TUR: {
      name: "TUR",
      symbol: "TUR",
      decimals: 10,
      ed: "100000000",
      toRaw: () => "0x0081000000000000000000000000000000000000000000000000000000000000",
      toQuery: () => "18446744073709551616",
    },
  },
};

export const astarRouteConfigs = createRouteConfigs("astar", [
  {
    to: "acala",
    token: "ASTR",
    xcm: {
      fee: { token: "ASTR", amount: "8082400000000000" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "acala",
    token: "ACA",
    xcm: {
      fee: { token: "ACA", amount: "8082400000" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "acala",
    token: "AUSD",
    xcm: {
      fee: { token: "AUSD", amount: "1815098681" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "acala",
    token: "LDOT",
    xcm: {
      fee: { token: "LDOT", amount: "13400229" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "hydradx",
    token: "ASTR",
    xcm: {
      fee: { token: "ASTR", amount: "44306118000000000" },
      weightLimit: "Unlimited",
    },
  },
]);

export const shidenRouteConfigs = createRouteConfigs("shiden", [
  {
    to: "turing",
    token: "SDN",
    xcm: {
      fee: { token: "SDN", amount: "801280000000000" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "turing",
    token: "TUR",
    xcm: {
      fee: { token: "TUR", amount: "2120203588" },
      weightLimit: "Unlimited",
    },
  },
]);

export const shibuyaRouteConfigs = createRouteConfigs("shiden", [
  {
    to: "turing-local",
    token: "SBY",
    xcm: {
      fee: { token: "SBY", amount: "801280000000000" },
      weightLimit: "Unlimited",
    },
  },
]);

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const createBalanceStorages = (api: AnyApi) => {
  return {
    balances: (address: string) =>
      Storage.create<DeriveBalancesAll>({
        api,
        path: "derive.balances.all",
        params: [address],
      }),
    assets: (tokenId: string, address: string) =>
      Storage.create<any>({
        api,
        path: "query.assets.account",
        params: [tokenId, address],
      }),
  };
};

class AstarBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor({ api, chain, tokens }: BalanceAdapterConfigs) {
    super({ api, chain, tokens });
    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance(token: string, address: string): Observable<BalanceData> {

    const tokenData: TokenData = this.getToken(token);

    if (!tokenData) throw new TokenNotFound(token);

    if (token === this.nativeToken) {
      return this.storages.balances(address).observable.pipe(
        map((data) => {
          return {
            free: FN.fromInner(data.availableBalance.toString(), this.decimals),
            locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
            reserved: FN.fromInner(data.reservedBalance.toString(), this.decimals),
            available: FN.fromInner(data.freeBalance.toString(), this.decimals),
          };
        }),
      );
    }

    return this.storages.assets(tokenData.toQuery(), address).observable.pipe(
      map((balance) => {
        const amount = FN.fromInner(balance.unwrapOrDefault()?.balance?.toString() || "0", this.getToken(token).decimals);

        return {
          free: amount,
          locked: new FN(0),
          reserved: new FN(0),
          available: amount,
        };
      }),
    );
  }
}

class BaseAstarAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: AstarBalanceAdapter;

  public async init(api: AnyApi) {
    this.api = api;

    await api.isReady;

    const chain = this.chain.id as ChainId;

    this.balanceAdapter = new AstarBalanceAdapter({
      chain,
      api,
      tokens: astarTokensConfig[chain],
    });
  }

  public subscribeTokenBalance(token: string, address: string): Observable<BalanceData> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return this.balanceAdapter.subscribeBalance(token, address);
  }

  public subscribeMaxInput(token: string, address: string, to: ChainId): Observable<FN> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return combineLatest({
      txFee:
        token === this.balanceAdapter?.nativeToken
          ? this.estimateTxFee({
            amount: FN.ZERO,
            to,
            token,
            address,
            signer: address,
          })
          : "0",
      balance: this.balanceAdapter.subscribeBalance(token, address).pipe(map((i) => i.available)),
    }).pipe(
      map(({ balance, txFee }) => {
        const tokenMeta = this.balanceAdapter?.getToken(token);
        const feeFactor = 1.2;
        const fee = FN.fromInner(txFee, tokenMeta?.decimals).mul(new FN(feeFactor));

        // always minus ed
        return balance.minus(fee).minus(FN.fromInner(tokenMeta?.ed || "0", tokenMeta?.decimals));
      }),
    );
  }

  public oldCreateTx(params: TransferParams): SubmittableExtrinsic<"promise", ISubmittableResult> | SubmittableExtrinsic<"rxjs", ISubmittableResult> {
    if (!this.api) throw new ApiNotFound(this.chain.id);

    const { address, amount, to, token } = params;

    if (!validateAddress(address)) throw new InvalidAddress(address);

    const toChain = chains[to];

    const accountId = this.api?.createType("AccountId32", address).toHex();
    const rawAmount = amount.toChainData();

    if (token === this.balanceAdapter?.nativeToken) {
      return this.api?.tx.polkadotXcm.reserveTransferAssets(
        createPolkadotXCMDest(this.api, toChain.paraChainId) as any,
        createPolkadotXCMAccount(this.api, accountId) as any,
        createPolkadotXCMAsset(this.api, rawAmount, "NATIVE") as any,
        0,
      );
    }

    const tokenIds: Record<string, string> = {
      // to karura
      KUSD: "0x0081000000000000000000000000000000000000000000000000000000000000",
      // to acala
      ACA: "0x0000000000000000000000000000000000000000000000000000000000000000",
      AUSD: "0x0001000000000000000000000000000000000000000000000000000000000000",
      LDOT: "0x0003000000000000000000000000000000000000000000000000000000000000",
    };

    const tokenId = tokenIds[token];

    if (!tokenId) throw new TokenNotFound(token);

    const paraChainId = toChain.paraChainId;

    return this.api?.tx.polkadotXcm.reserveWithdrawAssets(
      createPolkadotXCMDest(this.api, toChain.paraChainId),
      createPolkadotXCMAccount(this.api, accountId),
      createPolkadotXCMAsset(this.api, rawAmount, [{ Parachain: paraChainId }, { GeneralKey: { length: 2, data: tokenId } }]),
      0,
    );
  }

  public createTx(params: TransferParams): SubmittableExtrinsic<"promise", ISubmittableResult> | SubmittableExtrinsic<"rxjs", ISubmittableResult> {
    if (!this.api) throw new ApiNotFound(this.chain.id);

    if (this.chain.id === "astar" || !this.api.tx.xtokens) {
      return this.oldCreateTx(params);
    }

    const { address, amount, to, token } = params;

    if (!validateAddress(address)) throw new InvalidAddress(address);

    const toChain = chains[to];
    const accountId = this.api?.createType("AccountId32", address).toHex();

    if (token === this.balanceAdapter?.nativeToken) {
      return this.api.tx.xtokens.transferMultiasset(
        {
          V3: {
            id: { Concrete: { parents: 0, interior: "Here" } },
            fun: { Fungible: amount.toChainData() },
          },
        },
        {
          V3: {
            parents: 1,
            interior: {
              X2: [
                { Parachain: toChain.paraChainId },
                {
                  AccountId32: {
                    id: accountId,
                  },
                },
              ],
            },
          },
        },
        "Unlimited",
      );
    }

    const tokenData: TokenData = this.getToken(params.token);

    return this.api.tx.xtokens.transferMultiasset(
      {
        V3: {
          fun: { Fungible: amount.toChainData() },
          id: {
            Concrete: {
              parents: 1,
              interior: {
                X2: [{ Parachain: toChain.paraChainId }, { GeneralKey: { length: 2, data: tokenData.toRaw() } }],
              },
            },
          },
        },
      },
      {
        V3: {
          parents: 1,
          interior: {
            X2: [
              { Parachain: toChain.paraChainId },
              {
                AccountId32: {
                  id: accountId,
                },
              },
            ],
          },
        },
      },
      "Unlimited",
    );
  }
}

export class AstarAdapter extends BaseAstarAdapter {
  constructor() {
    super(chains.astar, astarRouteConfigs, astarTokensConfig.astar);
  }
}

export class ShidenAdapter extends BaseAstarAdapter {
  constructor() {
    super(chains.shiden, shidenRouteConfigs, astarTokensConfig.shiden);
  }
}

export class ShibuyaAdapter extends BaseAstarAdapter {
  constructor() {
    super(chains.shibuya, shibuyaRouteConfigs, astarTokensConfig.shibuya);
  }
}
