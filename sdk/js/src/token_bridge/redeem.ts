import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { MsgExecuteContract } from "@terra-money/terra.js";
import { Algodv2 } from "algosdk";
import { ethers, Overrides } from "ethers";
import { fromUint8Array } from "js-base64";
import { TransactionSignerPair, _submitVAAAlgorand } from "../algorand";
import { Bridge__factory } from "../ethers-contracts";
import { ixFromRust } from "../solana";
import { importCoreWasm, importTokenWasm } from "../solana/wasm";
import {
  CHAIN_ID_NEAR,
  CHAIN_ID_SOLANA,
  ChainId,
  ChainName,
  MAX_VAA_DECIMALS,
  WSOL_ADDRESS,
  WSOL_DECIMALS,
  uint8ArrayToHex
} from "../utils";

import {
    getForeignAssetNear
} from ".";

import {
  _parseVAAAlgorand,
} from "../algorand";

import { hexToNativeString } from "../utils/array";
import { parseTransferPayload } from "../utils/parseVaa";
import { Account as nearAccount } from "near-api-js";
import BN from "bn.js";
import { providers as nearProviders } from "near-api-js";

export async function redeemOnEth(
  tokenBridgeAddress: string,
  signer: ethers.Signer,
  signedVAA: Uint8Array,
  overrides: Overrides & { from?: string | Promise<string> } = {}
) {
  const bridge = Bridge__factory.connect(tokenBridgeAddress, signer);
  const v = await bridge.completeTransfer(signedVAA, overrides);
  const receipt = await v.wait();
  return receipt;
}

export async function redeemOnEthNative(
  tokenBridgeAddress: string,
  signer: ethers.Signer,
  signedVAA: Uint8Array,
  overrides: Overrides & { from?: string | Promise<string> } = {}
) {
  const bridge = Bridge__factory.connect(tokenBridgeAddress, signer);
  const v = await bridge.completeTransferAndUnwrapETH(signedVAA, overrides);
  const receipt = await v.wait();
  return receipt;
}

export async function redeemOnTerra(
  tokenBridgeAddress: string,
  walletAddress: string,
  signedVAA: Uint8Array
) {
  return new MsgExecuteContract(walletAddress, tokenBridgeAddress, {
    submit_vaa: {
      data: fromUint8Array(signedVAA),
    },
  });
}

export async function redeemAndUnwrapOnSolana(
  connection: Connection,
  bridgeAddress: string,
  tokenBridgeAddress: string,
  payerAddress: string,
  signedVAA: Uint8Array
) {
  const { parse_vaa } = await importCoreWasm();
  const { complete_transfer_native_ix } = await importTokenWasm();
  const parsedVAA = parse_vaa(signedVAA);
  const parsedPayload = parseTransferPayload(
    Buffer.from(new Uint8Array(parsedVAA.payload))
  );
  const targetAddress = hexToNativeString(
    parsedPayload.targetAddress,
    CHAIN_ID_SOLANA
  );
  if (!targetAddress) {
    throw new Error("Failed to read the target address.");
  }
  const targetPublicKey = new PublicKey(targetAddress);
  const targetAmount =
    parsedPayload.amount *
    BigInt(WSOL_DECIMALS - MAX_VAA_DECIMALS) *
    BigInt(10);
  const rentBalance = await Token.getMinBalanceRentForExemptAccount(connection);
  const mintPublicKey = new PublicKey(WSOL_ADDRESS);
  const payerPublicKey = new PublicKey(payerAddress);
  const ancillaryKeypair = Keypair.generate();

  const completeTransferIx = ixFromRust(
    complete_transfer_native_ix(
      tokenBridgeAddress,
      bridgeAddress,
      payerAddress,
      signedVAA
    )
  );

  //This will create a temporary account where the wSOL will be moved
  const createAncillaryAccountIx = SystemProgram.createAccount({
    fromPubkey: payerPublicKey,
    newAccountPubkey: ancillaryKeypair.publicKey,
    lamports: rentBalance, //spl token accounts need rent exemption
    space: AccountLayout.span,
    programId: TOKEN_PROGRAM_ID,
  });

  //Initialize the account as a WSOL account, with the original payerAddress as owner
  const initAccountIx = await Token.createInitAccountInstruction(
    TOKEN_PROGRAM_ID,
    mintPublicKey,
    ancillaryKeypair.publicKey,
    payerPublicKey
  );

  //Send in the amount of wSOL which we want converted to SOL
  const balanceTransferIx = Token.createTransferInstruction(
    TOKEN_PROGRAM_ID,
    targetPublicKey,
    ancillaryKeypair.publicKey,
    payerPublicKey,
    [],
    new u64(targetAmount.toString(16), 16)
  );

  //Close the ancillary account for cleanup. Payer address receives any remaining funds
  const closeAccountIx = Token.createCloseAccountInstruction(
    TOKEN_PROGRAM_ID,
    ancillaryKeypair.publicKey, //account to close
    payerPublicKey, //Remaining funds destination
    payerPublicKey, //authority
    []
  );

  const { blockhash } = await connection.getRecentBlockhash();
  const transaction = new Transaction();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = new PublicKey(payerAddress);
  transaction.add(completeTransferIx);
  transaction.add(createAncillaryAccountIx);
  transaction.add(initAccountIx);
  transaction.add(balanceTransferIx);
  transaction.add(closeAccountIx);
  transaction.partialSign(ancillaryKeypair);
  return transaction;
}

export async function redeemOnSolana(
  connection: Connection,
  bridgeAddress: string,
  tokenBridgeAddress: string,
  payerAddress: string,
  signedVAA: Uint8Array,
  feeRecipientAddress?: string
) {
  const { parse_vaa } = await importCoreWasm();
  const parsedVAA = parse_vaa(signedVAA);
  const isSolanaNative =
    Buffer.from(new Uint8Array(parsedVAA.payload)).readUInt16BE(65) ===
    CHAIN_ID_SOLANA;
  const { complete_transfer_wrapped_ix, complete_transfer_native_ix } =
    await importTokenWasm();
  const ixs = [];
  if (isSolanaNative) {
    ixs.push(
      ixFromRust(
        complete_transfer_native_ix(
          tokenBridgeAddress,
          bridgeAddress,
          payerAddress,
          signedVAA,
          feeRecipientAddress
        )
      )
    );
  } else {
    ixs.push(
      ixFromRust(
        complete_transfer_wrapped_ix(
          tokenBridgeAddress,
          bridgeAddress,
          payerAddress,
          signedVAA,
          feeRecipientAddress
        )
      )
    );
  }
  const transaction = new Transaction().add(...ixs);
  const { blockhash } = await connection.getRecentBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = new PublicKey(payerAddress);
  return transaction;
}

/**
 * This basically just submits the VAA to Algorand
 * @param client AlgodV2 client
 * @param tokenBridgeId Token bridge ID
 * @param bridgeId Core bridge ID
 * @param vaa The VAA to be redeemed
 * @param acct Sending account
 * @returns Transaction ID(s)
 */
export async function redeemOnAlgorand(
  client: Algodv2,
  tokenBridgeId: bigint,
  bridgeId: bigint,
  vaa: Uint8Array,
  senderAddr: string
): Promise<TransactionSignerPair[]> {
  return await _submitVAAAlgorand(
    client,
    tokenBridgeId,
    bridgeId,
    vaa,
    senderAddr
  );
}

/**
 * This basically just submits the VAA to Near
 * @param client
 * @param tokenBridge Token bridge ID
 * @param vaa The VAA to be redeemed
 * @returns Transaction ID(s)
 */
export async function redeemOnNear(
  client: nearAccount,
  tokenBridge: string,
  vaa: Uint8Array
): Promise<String> {
  let p = _parseVAAAlgorand(vaa);

  if (p.ToChain !== CHAIN_ID_NEAR) {
    throw new Error("Not destined for NEAR");
  }

  let user = await client.viewFunction(tokenBridge, "hash_lookup", {
    hash: uint8ArrayToHex(p.ToAddress as Uint8Array),
  });

  if (!user[0]) {
    throw new Error(
      "Unregistered receiver (receiving account is not registered)"
    );
  }

  user = user[1];

  let token = await getForeignAssetNear(
    client,
    tokenBridge,
    p.FromChain as ChainId,
    p.Contract as string
  );

  if (token === "") {
    throw new Error("Unregistered token (this been attested yet?)");
  }

  if (
    (p.Contract as string) !==
    "0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    let bal = await client.viewFunction(token as string, "storage_balance_of", {
      account_id: user,
    });

    if (bal === null) {
      console.log("Registering ", user, " for ", token);
      bal = nearProviders.getTransactionLastResult(
        await client.functionCall({
          contractId: token as string,
          methodName: "storage_deposit",
          args: { account_id: user, registration_only: true },
          gas: new BN("100000000000000"),
          attachedDeposit: new BN("2000000000000000000000"), // 0.002 NEAR
        })
      );
    }

    if (
      p.Fee !== undefined &&
      Buffer.compare(
        p.Fee,
        Buffer.from(
          "0000000000000000000000000000000000000000000000000000000000000000",
          "hex"
        )
      ) !== 0
    ) {
      let bal = await client.viewFunction(
        token as string,
        "storage_balance_of",
        {
          account_id: client.accountId,
        }
      );

      if (bal === null) {
        console.log("Registering ", client.accountId, " for ", token);
        bal = nearProviders.getTransactionLastResult(
          await client.functionCall({
            contractId: token as string,
            methodName: "storage_deposit",
            args: { account_id: client.accountId, registration_only: true },
            gas: new BN("100000000000000"),
            attachedDeposit: new BN("2000000000000000000000"), // 0.002 NEAR
          })
        );
      }
    }
  }

  let result = await client.functionCall({
    contractId: tokenBridge,
    methodName: "submit_vaa",
    args: {
      vaa: uint8ArrayToHex(vaa),
    },
    attachedDeposit: new BN("100000000000000000000000"),
    gas: new BN("150000000000000"),
  });

  result = await client.functionCall({
    contractId: tokenBridge,
    methodName: "submit_vaa",
    args: {
      vaa: uint8ArrayToHex(vaa),
    },
    attachedDeposit: new BN("100000000000000000000000"),
    gas: new BN("150000000000000"),
  });

  return nearProviders.getTransactionLastResult(result);
}
