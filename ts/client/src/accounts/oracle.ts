import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Magic as PythMagic } from '@pythnetwork/client';
import { AccountInfo, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SB_ON_DEMAND_PID, toFeedValue } from '@switchboard-xyz/on-demand';
import SwitchboardProgram from '@switchboard-xyz/sbv2-lite';
import Big from 'big.js';
import BN from 'bn.js';
import { Program as Anchor30Program } from 'switchboard-anchor';

import { I80F48, I80F48Dto } from '../numbers/I80F48';

const SBV1_DEVNET_PID = new PublicKey(
  '7azgmy1pFXHikv36q1zZASvFq5vFa39TT9NweVugKKTU',
);
const SBV1_MAINNET_PID = new PublicKey(
  'DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM',
);
let sbv2DevnetProgram;
let sbv2MainnetProgram;
let sbOnDemandProgram;

export enum OracleProvider {
  Pyth,
  Switchboard,
  Stub,
}

export class StubOracle {
  public price: I80F48;
  public deviation: I80F48;

  static from(
    publicKey: PublicKey,
    obj: {
      group: PublicKey;
      mint: PublicKey;
      price: I80F48Dto;
      lastUpdateTs: BN;
      lastUpdateSlot: BN;
      deviation: I80F48Dto;
    },
  ): StubOracle {
    return new StubOracle(
      publicKey,
      obj.group,
      obj.mint,
      obj.price,
      obj.lastUpdateTs,
      obj.lastUpdateSlot,
      obj.deviation,
    );
  }

  constructor(
    public publicKey: PublicKey,
    public group: PublicKey,
    public mint: PublicKey,
    price: I80F48Dto,
    public lastUpdateTs: BN,
    public lastUpdateSlot: BN,
    deviation: I80F48Dto,
  ) {
    this.price = I80F48.from(price);
    this.deviation = I80F48.from(deviation);
  }
}

// https://gist.github.com/microwavedcola1/b741a11e6ee273a859f3ef00b35ac1f0
export function parseSwitchboardOracleV1(accountInfo: AccountInfo<Buffer>): {
  price: number;
  lastUpdatedSlot: number;
  uiDeviation: number;
} {
  const price = accountInfo.data.readDoubleLE(1 + 32 + 4 + 4);
  const lastUpdatedSlot = parseInt(
    accountInfo.data.readBigUInt64LE(1 + 32 + 4 + 4 + 8).toString(),
  );
  const minResponse = accountInfo.data.readDoubleLE(1 + 32 + 4 + 4 + 8 + 8 + 8);
  const maxResponse = accountInfo.data.readDoubleLE(
    1 + 32 + 4 + 4 + 8 + 8 + 8 + 8,
  );
  return { price, lastUpdatedSlot, uiDeviation: maxResponse - minResponse };
}

export function switchboardDecimalToBig(sbDecimal: {
  mantissa: BN;
  scale: number;
}): Big {
  const mantissa = new Big(sbDecimal.mantissa.toString());
  const scale = sbDecimal.scale;
  const oldDp = Big.DP;
  Big.DP = 20;
  const result: Big = mantissa.div(new Big(10).pow(scale));
  Big.DP = oldDp;
  return result;
}

export function parseSwitchboardOracleV2(
  program: SwitchboardProgram,
  accountInfo: AccountInfo<Buffer>,
  oracle: PublicKey,
): { price: number; lastUpdatedSlot: number; uiDeviation: number } {
  try {
    //
    const price = program.decodeLatestAggregatorValue(accountInfo)!.toNumber();
    const lastUpdatedSlot = program
      .decodeAggregator(accountInfo)
      .latestConfirmedRound!.roundOpenSlot!.toNumber();
    const stdDeviation = switchboardDecimalToBig(
      program.decodeAggregator(accountInfo).latestConfirmedRound.stdDeviation,
    );

    return { price, lastUpdatedSlot, uiDeviation: stdDeviation.toNumber() };
    // if oracle is badly configured or didn't publish price at least once
    // decodeLatestAggregatorValue can throw (0 switchboard rounds).
  } catch (e) {
    console.log(`Unable to parse Switchboard Oracle V2: ${oracle}`, e);
    return { price: 0, lastUpdatedSlot: 0, uiDeviation: 0 };
  }
}

export function parseSwitchboardOnDemandOracle(
  program: any,
  accountInfo: AccountInfo<Buffer>,
  oracle: PublicKey,
): { price: number; lastUpdatedSlot: number; uiDeviation: number } {
  try {
    const decodedPullFeed = program.coder.accounts.decode(
      'pullFeedAccountData',
      accountInfo.data,
    );

    if (decodedPullFeed.result == undefined) {
      const feedValue = toFeedValue(decodedPullFeed.submissions, new BN(0));
      console.log(decodedPullFeed.submissions);
      console.log(feedValue);
      const price = new Big(feedValue?.value.toString()).div(1e18);
      const lastUpdatedSlot = feedValue!.slot!.toNumber(); // TODO the !
      const stdDeviation = 0; // TODO the 0
      return { price, lastUpdatedSlot, uiDeviation: stdDeviation };
    }

    const price = new Big(decodedPullFeed.result.value.toString()).div(1e18);
    const lastUpdatedSlot = decodedPullFeed.result.slot.toNumber();
    const stdDeviation = decodedPullFeed.result.stdDev.toNumber();
    return { price, lastUpdatedSlot, uiDeviation: stdDeviation };
  } catch (e) {
    console.log(
      `Unable to parse Switchboard On-Demand Oracle V2: ${oracle}`,
      e,
    );
    return { price: 0, lastUpdatedSlot: 0, uiDeviation: 0 };
  }
}

export async function parseSwitchboardOracle(
  oracle: PublicKey,
  accountInfo: AccountInfo<Buffer>,
  connection: Connection,
): Promise<{ price: number; lastUpdatedSlot: number; uiDeviation: number }> {
  if (accountInfo.owner.equals(SB_ON_DEMAND_PID)) {
    if (!sbOnDemandProgram) {
      const options = AnchorProvider.defaultOptions();
      const provider = new AnchorProvider(
        connection,
        new Wallet(new Keypair()),
        options,
      );
      const idl = await Anchor30Program.fetchIdl(SB_ON_DEMAND_PID, provider);
      sbOnDemandProgram = new Anchor30Program(idl!, provider);
    }
    return parseSwitchboardOnDemandOracle(
      sbOnDemandProgram,
      accountInfo,
      oracle,
    );
  }

  if (accountInfo.owner.equals(SwitchboardProgram.devnetPid)) {
    if (!sbv2DevnetProgram) {
      sbv2DevnetProgram = await SwitchboardProgram.loadDevnet(connection);
    }
    return parseSwitchboardOracleV2(sbv2DevnetProgram, accountInfo, oracle);
  }

  if (accountInfo.owner.equals(SwitchboardProgram.mainnetPid)) {
    if (!sbv2MainnetProgram) {
      sbv2MainnetProgram = await SwitchboardProgram.loadMainnet(connection);
    }
    return parseSwitchboardOracleV2(sbv2MainnetProgram, accountInfo, oracle);
  }

  if (
    accountInfo.owner.equals(SBV1_DEVNET_PID) ||
    accountInfo.owner.equals(SBV1_MAINNET_PID)
  ) {
    return parseSwitchboardOracleV1(accountInfo);
  }

  throw new Error(`Should not be reached!`);
}

export function isSwitchboardOracle(accountInfo: AccountInfo<Buffer>): boolean {
  if (
    accountInfo.owner.equals(SBV1_DEVNET_PID) ||
    accountInfo.owner.equals(SBV1_MAINNET_PID) ||
    accountInfo.owner.equals(SwitchboardProgram.devnetPid) ||
    accountInfo.owner.equals(SwitchboardProgram.mainnetPid) ||
    accountInfo.owner.equals(SB_ON_DEMAND_PID)
  ) {
    return true;
  }
  return false;
}

export function isPythOracle(accountInfo: AccountInfo<Buffer>): boolean {
  return accountInfo.data.readUInt32LE(0) === PythMagic;
}

export function isOracleStaleOrUnconfident(
  nowSlot: number,
  maxStalenessSlots: number,
  oracleLastUpdatedSlot: number | undefined,
  deviation: I80F48 | undefined,
  confFilter: I80F48,
  price: I80F48,
): boolean {
  if (
    maxStalenessSlots >= 0 &&
    oracleLastUpdatedSlot &&
    nowSlot > oracleLastUpdatedSlot + maxStalenessSlots
  ) {
    return true;
  }

  if (deviation && deviation.gt(confFilter.mul(price))) {
    return true;
  }

  return false;
}
