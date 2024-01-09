import { expect } from "chai";
import * as hardhat from "hardhat";
import * as fs from "fs";
import { diamondCut } from "../../src.ts/diamondCut";
import type { ExecutorFacet, GettersFacet, AdminFacet, ZkSyncStateTransition } from "../../typechain";
import {
  ExecutorFacetFactory,
  GettersFacetFactory,
  AdminFacetFactory,
  DefaultUpgradeFactory,
  CustomUpgradeTestFactory,
  ZkSyncStateTransitionFactory,
} from "../../typechain";
import type { StoredBatchInfo, CommitBatchInfo } from "./utils";
import {
  getCallRevertReason,
  EMPTY_STRING_KECCAK,
  genesisStoredBatchInfo,
  L2_SYSTEM_CONTEXT_ADDRESS,
  L2_BOOTLOADER_ADDRESS,
  createSystemLogs,
  SYSTEM_LOG_KEYS,
  constructL2Log,
  packBatchTimestampAndBatchTimestamp,
  initialDeployment,
  createSystemLogsWithUpgrade,
} from "./utils";
import * as ethers from "ethers";
import type { BigNumberish, BytesLike } from "ethers";
import { Wallet } from "ethers";
import { REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT, hashBytecode } from "zksync-ethers/build/src/utils";

// process.env.CONTRACTS_LATEST_PROTOCOL_VERSION = CONTRACTS_LATEST_PROTOCOL_VERSION;

const L2_BOOTLOADER_BYTECODE_HASH = "0x1000100000000000000000000000000000000000000000000000000000000000";
const L2_DEFAULT_ACCOUNT_BYTECODE_HASH = "0x1001000000000000000000000000000000000000000000000000000000000000";

const testConfigPath = "./test/test_config/constant";
const ethTestConfig = JSON.parse(fs.readFileSync(`${testConfigPath}/eth.json`, { encoding: "utf-8" }));

const SYSTEM_UPGRADE_TX_TYPE = 254;

describe("L2 upgrade test", function () {
  let proxyExecutor: ExecutorFacet;
  let proxyAdmin: AdminFacet;
  let proxyGetters: GettersFacet;

  let stateTransition: ZkSyncStateTransition;

  let owner: ethers.Signer;

  let batch1InfoChainIdUpgrade: CommitBatchInfo;
  let storedBatch1InfoChainIdUpgrade: StoredBatchInfo;

  let batch2Info: CommitBatchInfo;
  let storedBatch2Info: StoredBatchInfo;

  let verifier: string;
  const noopUpgradeTransaction = buildL2CanonicalTransaction({ txType: 0 });
  let chainId = process.env.CHAIN_ETH_ZKSYNC_NETWORK_ID || 270;
  // let priorityOperationsHash: string;
  let initialProtocolVersion = 0;

  before(async () => {
    [owner] = await hardhat.ethers.getSigners();

    const deployWallet = Wallet.fromMnemonic(ethTestConfig.test_mnemonic3, "m/44'/60'/0'/0/1").connect(owner.provider);
    const ownerAddress = await deployWallet.getAddress();

    const gasPrice = await owner.provider.getGasPrice();

    const tx = {
      from: owner.getAddress(),
      to: deployWallet.address,
      value: ethers.utils.parseEther("1000"),
      nonce: owner.getTransactionCount(),
      gasLimit: 100000,
      gasPrice: gasPrice,
    };

    await owner.sendTransaction(tx);

    const deployer = await initialDeployment(deployWallet, ownerAddress, gasPrice, []);
    initialProtocolVersion = parseInt(process.env.CONTRACTS_LATEST_PROTOCOL_VERSION);

    chainId = deployer.chainId;
    verifier = deployer.addresses.StateTransition.Verifier;

    proxyExecutor = ExecutorFacetFactory.connect(deployer.addresses.StateTransition.DiamondProxy, deployWallet);
    proxyGetters = GettersFacetFactory.connect(deployer.addresses.StateTransition.DiamondProxy, deployWallet);
    proxyAdmin = AdminFacetFactory.connect(deployer.addresses.StateTransition.DiamondProxy, deployWallet);

    stateTransition = ZkSyncStateTransitionFactory.connect(
      deployer.addresses.StateTransition.StateTransitionProxy,
      deployWallet
    );

    await (await proxyAdmin.setValidator(await deployWallet.getAddress(), true)).wait();

    //     let priorityOp = await proxyGetters.priorityQueueFrontOperation();
    //     // priorityOpTxHash = priorityOp[0];
    //     priorityOperationsHash = keccak256(
    //         ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [EMPTY_STRING_KECCAK, priorityOp[0]])
    //     );

    // do initial setChainIdUpgrade
    const upgradeTxHash = await proxyGetters.getL2SystemContractsUpgradeTxHash();
    batch1InfoChainIdUpgrade = await buildCommitBatchInfoWithUpgrade(
      genesisStoredBatchInfo(),
      {
        batchNumber: 1,
        // priorityOperationsHash: priorityOperationsHash,
        // numberOfLayer1Txs: '0x0000000000000000000000000000000000000000000000000000000000000001'
        priorityOperationsHash: EMPTY_STRING_KECCAK,
        numberOfLayer1Txs: "0x0000000000000000000000000000000000000000000000000000000000000000",
        // systemLogs
      },
      upgradeTxHash
    );

    const commitReceipt = await (
      await proxyExecutor.commitBatches(genesisStoredBatchInfo(), [batch1InfoChainIdUpgrade])
    ).wait();
    const commitment = commitReceipt.events[0].args.commitment;
    storedBatch1InfoChainIdUpgrade = getBatchStoredInfo(batch1InfoChainIdUpgrade, commitment);
    await makeExecutedEqualCommitted(proxyExecutor, genesisStoredBatchInfo(), [storedBatch1InfoChainIdUpgrade], []);
  });

  it("Upgrade should work even if not all batches are processed", async () => {
    batch2Info = await buildCommitBatchInfo(storedBatch1InfoChainIdUpgrade, {
      batchNumber: 2,
      // priorityOperationsHash: priorityOperationsHash,
      // numberOfLayer1Txs: '0x0000000000000000000000000000000000000000000000000000000000000001'
      priorityOperationsHash: EMPTY_STRING_KECCAK,
      numberOfLayer1Txs: "0x0000000000000000000000000000000000000000000000000000000000000000",
      // systemLogs
    });

    const commitReceipt = await (
      await proxyExecutor.commitBatches(storedBatch1InfoChainIdUpgrade, [batch2Info])
    ).wait();
    const commitment = commitReceipt.events[0].args.commitment;

    expect(await proxyGetters.getProtocolVersion()).to.equal(initialProtocolVersion);
    expect(await proxyGetters.getL2SystemContractsUpgradeTxHash()).to.equal(ethers.constants.HashZero);

    await (
      await executeUpgrade(chainId, proxyGetters, stateTransition, {
        newProtocolVersion: 1 + initialProtocolVersion,
        l2ProtocolUpgradeTx: noopUpgradeTransaction,
      })
    ).wait();

    expect(await proxyGetters.getProtocolVersion()).to.equal(1 + initialProtocolVersion);

    storedBatch2Info = getBatchStoredInfo(batch2Info, commitment);

    await makeExecutedEqualCommitted(proxyExecutor, storedBatch1InfoChainIdUpgrade, [storedBatch2Info], []);
  });

  it("Timestamp should behave correctly", async () => {
    // Upgrade was scheduled for now should work fine
    const timeNow = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    await executeUpgrade(chainId, proxyGetters, stateTransition, {
      upgradeTimestamp: ethers.BigNumber.from(timeNow),
      l2ProtocolUpgradeTx: noopUpgradeTransaction,
    });

    // Upgrade that was scheduled for the future should not work now
    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        upgradeTimestamp: ethers.BigNumber.from(timeNow).mul(2),
        l2ProtocolUpgradeTx: noopUpgradeTransaction,
      })
    );
    expect(revertReason).to.equal("Upgrade is not ready yet");
  });

  it("Should require correct tx type for upgrade tx", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      txType: 255,
    });
    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 3 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("L2 sys upgrade tx type is wrong");
  });

  it("Should include the new protocol version as part of nonce", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      txType: 254,
      nonce: 0,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("The new protocol version should be included in the L2 system upgrade tx");
  });

  it("Should ensure monotonic protocol version", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      txType: 254,
      nonce: 0,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 0,
      })
    );

    expect(revertReason).to.equal("New protocol version is not greater than the current one");
  });

  it("Should ensure protocol version not increasing too much", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      txType: 254,
      nonce: 0,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 100000,
      })
    );

    expect(revertReason).to.equal("Too big protocol version difference");
  });

  it("Should validate upgrade transaction overhead", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      nonce: 0,
      gasLimit: 0,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("my");
  });

  it("Should validate upgrade transaction gas max", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      nonce: 0,
      gasLimit: 1000000000000,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("ui");
  });

  it("Should validate upgrade transaction cant output more pubdata than processable", async () => {
    const wrongTx = buildL2CanonicalTransaction({
      nonce: 0,
      gasLimit: 10000000,
      gasPerPubdataByteLimit: 1,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("uk");
  });

  it("Should validate factory deps", async () => {
    const myFactoryDep = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const wrongFactoryDepHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));
    const wrongTx = buildL2CanonicalTransaction({
      factoryDeps: [wrongFactoryDepHash],
      nonce: 3 + 1 + initialProtocolVersion,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        factoryDeps: [myFactoryDep],
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("Wrong factory dep hash");
  });

  it("Should validate factory deps length match", async () => {
    const myFactoryDep = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const wrongTx = buildL2CanonicalTransaction({
      factoryDeps: [],
      nonce: 3 + 1 + initialProtocolVersion,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        factoryDeps: [myFactoryDep],
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("Wrong number of factory deps");
  });

  it("Should validate factory deps length isnt too large", async () => {
    const myFactoryDep = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const randomDepHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));

    const wrongTx = buildL2CanonicalTransaction({
      factoryDeps: Array(33).fill(randomDepHash),
      nonce: 3 + 1 + initialProtocolVersion,
    });

    const revertReason = await getCallRevertReason(
      executeUpgrade(chainId, proxyGetters, stateTransition, {
        l2ProtocolUpgradeTx: wrongTx,
        factoryDeps: Array(33).fill(myFactoryDep),
        newProtocolVersion: 3 + 1 + initialProtocolVersion,
      })
    );

    expect(revertReason).to.equal("Factory deps can be at most 32");
  });

  let l2UpgradeTxHash: string;
  it("Should successfully perform an upgrade", async () => {
    const bootloaderHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));
    const defaultAccountHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));
    const newVerifier = ethers.utils.hexlify(ethers.utils.randomBytes(20));
    const newerVerifierParams = buildVerifierParams({
      recursionNodeLevelVkHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      recursionLeafLevelVkHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      recursionCircuitsSetVksHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    });

    const myFactoryDep = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const myFactoryDepHash = hashBytecode(myFactoryDep);
    const upgradeTx = buildL2CanonicalTransaction({
      factoryDeps: [myFactoryDepHash],
      nonce: 4 + 1 + initialProtocolVersion,
    });

    const upgrade = {
      bootloaderHash,
      defaultAccountHash,
      verifier: newVerifier,
      verifierParams: newerVerifierParams,
      executeUpgradeTx: true,
      l2ProtocolUpgradeTx: upgradeTx,
      factoryDeps: [myFactoryDep],
      newProtocolVersion: 4 + 1 + initialProtocolVersion,
    };

    const upgradeReceipt = await (await executeUpgrade(chainId, proxyGetters, stateTransition, upgrade)).wait();

    const defaultUpgradeFactory = await hardhat.ethers.getContractFactory("DefaultUpgrade");
    const upgradeEvents = upgradeReceipt.logs.map((log) => {
      // Not all events can be parsed there, but we don't care about them
      try {
        const event = defaultUpgradeFactory.interface.parseLog(log);
        const parsedArgs = event.args;
        return {
          name: event.name,
          args: parsedArgs,
        };
      } catch (_) {}
    });
    l2UpgradeTxHash = upgradeEvents.find((event) => event.name == "UpgradeComplete").args.l2UpgradeTxHash;

    // Now, we check that all the data was set as expected
    expect(await proxyGetters.getL2BootloaderBytecodeHash()).to.equal(bootloaderHash);
    expect(await proxyGetters.getL2DefaultAccountBytecodeHash()).to.equal(defaultAccountHash);
    expect((await proxyGetters.getVerifier()).toLowerCase()).to.equal(newVerifier.toLowerCase());
    expect(await proxyGetters.getProtocolVersion()).to.equal(4 + 1 + initialProtocolVersion);

    const newVerifierParams = await proxyGetters.getVerifierParams();
    expect(newVerifierParams.recursionNodeLevelVkHash).to.equal(newerVerifierParams.recursionNodeLevelVkHash);
    expect(newVerifierParams.recursionLeafLevelVkHash).to.equal(newerVerifierParams.recursionLeafLevelVkHash);
    expect(newVerifierParams.recursionCircuitsSetVksHash).to.equal(newerVerifierParams.recursionCircuitsSetVksHash);

    expect(upgradeEvents[0].name).to.eq("NewProtocolVersion");
    expect(upgradeEvents[0].args.previousProtocolVersion.toString()).to.eq((2 + initialProtocolVersion).toString());
    expect(upgradeEvents[0].args.newProtocolVersion.toString()).to.eq((4 + 1 + initialProtocolVersion).toString());

    expect(upgradeEvents[1].name).to.eq("NewVerifier");
    expect(upgradeEvents[1].args.oldVerifier.toLowerCase()).to.eq(verifier.toLowerCase());
    expect(upgradeEvents[1].args.newVerifier.toLowerCase()).to.eq(newVerifier.toLowerCase());

    expect(upgradeEvents[2].name).to.eq("NewVerifierParams");
    expect(upgradeEvents[2].args.oldVerifierParams[0]).to.eq(ethers.constants.HashZero);
    expect(upgradeEvents[2].args.oldVerifierParams[1]).to.eq(ethers.constants.HashZero);
    expect(upgradeEvents[2].args.oldVerifierParams[2]).to.eq(ethers.constants.HashZero);
    expect(upgradeEvents[2].args.newVerifierParams[0]).to.eq(newerVerifierParams.recursionNodeLevelVkHash);
    expect(upgradeEvents[2].args.newVerifierParams[1]).to.eq(newerVerifierParams.recursionLeafLevelVkHash);
    expect(upgradeEvents[2].args.newVerifierParams[2]).to.eq(newerVerifierParams.recursionCircuitsSetVksHash);

    expect(upgradeEvents[3].name).to.eq("NewL2BootloaderBytecodeHash");
    expect(upgradeEvents[3].args.previousBytecodeHash).to.eq(L2_BOOTLOADER_BYTECODE_HASH);
    expect(upgradeEvents[3].args.newBytecodeHash).to.eq(bootloaderHash);

    expect(upgradeEvents[4].name).to.eq("NewL2DefaultAccountBytecodeHash");
    expect(upgradeEvents[4].args.previousBytecodeHash).to.eq(L2_DEFAULT_ACCOUNT_BYTECODE_HASH);
    expect(upgradeEvents[4].args.newBytecodeHash).to.eq(defaultAccountHash);
  });

  it("Should fail to upgrade when there is already a pending upgrade", async () => {
    const bootloaderHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));
    const defaultAccountHash = ethers.utils.hexlify(hashBytecode(ethers.utils.randomBytes(32)));
    const verifier = ethers.utils.hexlify(ethers.utils.randomBytes(20));
    const verifierParams = buildVerifierParams({
      recursionNodeLevelVkHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      recursionLeafLevelVkHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      recursionCircuitsSetVksHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    });

    const myFactoryDep = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const myFactoryDepHash = hashBytecode(myFactoryDep);
    const upgradeTx = buildL2CanonicalTransaction({
      factoryDeps: [myFactoryDepHash],
      nonce: 5 + 1 + initialProtocolVersion,
    });

    const upgrade = {
      bootloaderHash,
      defaultAccountHash,
      verifier: verifier,
      verifierParams,
      executeUpgradeTx: true,
      l2ProtocolUpgradeTx: upgradeTx,
      factoryDeps: [myFactoryDep],
      newProtocolVersion: 5 + 1 + initialProtocolVersion,
    };
    const revertReason = await getCallRevertReason(executeUpgrade(chainId, proxyGetters, stateTransition, upgrade));
    await rollBackToVersion((4 + 1 + initialProtocolVersion).toString(), stateTransition, upgrade);
    expect(revertReason).to.equal("Previous upgrade has not been finalized");
  });

  it("Should require that the next commit batches contains an upgrade tx", async () => {
    if (!l2UpgradeTxHash) {
      throw new Error("Can not perform this test without l2UpgradeTxHash");
    }

    const batch3InfoNoUpgradeTx = await buildCommitBatchInfo(storedBatch2Info, {
      batchNumber: 3,
    });
    const revertReason = await getCallRevertReason(
      proxyExecutor.commitBatches(storedBatch2Info, [batch3InfoNoUpgradeTx])
    );
    expect(revertReason).to.equal("b8");
  });

  it("Should ensure any additional upgrade logs go to the priority ops hash", async () => {
    if (!l2UpgradeTxHash) {
      throw new Error("Can not perform this test without l2UpgradeTxHash");
    }

    const systemLogs = createSystemLogs();
    systemLogs.push(
      constructL2Log(
        true,
        L2_BOOTLOADER_ADDRESS,
        SYSTEM_LOG_KEYS.EXPECTED_SYSTEM_CONTRACT_UPGRADE_TX_HASH_KEY,
        l2UpgradeTxHash
      )
    );
    systemLogs.push(
      constructL2Log(
        true,
        L2_BOOTLOADER_ADDRESS,
        SYSTEM_LOG_KEYS.EXPECTED_SYSTEM_CONTRACT_UPGRADE_TX_HASH_KEY,
        l2UpgradeTxHash
      )
    );
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch3InfoNoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 3,
      },
      systemLogs
    );
    const revertReason = await getCallRevertReason(
      proxyExecutor.commitBatches(storedBatch2Info, [batch3InfoNoUpgradeTx])
    );
    expect(revertReason).to.equal("kp");
  });

  it("Should fail to commit when upgrade tx hash does not match", async () => {
    const timestamp = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    const systemLogs = createSystemLogs();
    systemLogs.push(
      constructL2Log(
        true,
        L2_BOOTLOADER_ADDRESS,
        SYSTEM_LOG_KEYS.EXPECTED_SYSTEM_CONTRACT_UPGRADE_TX_HASH_KEY,
        ethers.constants.HashZero
      )
    );
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch3InfoTwoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 3,
        timestamp,
      },
      systemLogs
    );

    const revertReason = await getCallRevertReason(
      proxyExecutor.commitBatches(storedBatch2Info, [batch3InfoTwoUpgradeTx])
    );
    expect(revertReason).to.equal("ut");
  });

  it("Should commit successfully when the upgrade tx is present", async () => {
    const timestamp = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    const systemLogs = createSystemLogs();
    systemLogs.push(
      constructL2Log(
        true,
        L2_BOOTLOADER_ADDRESS,
        SYSTEM_LOG_KEYS.EXPECTED_SYSTEM_CONTRACT_UPGRADE_TX_HASH_KEY,
        l2UpgradeTxHash
      )
    );
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch3InfoTwoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 3,
        timestamp,
      },
      systemLogs
    );

    await (await proxyExecutor.commitBatches(storedBatch2Info, [batch3InfoTwoUpgradeTx])).wait();

    expect(await proxyGetters.getL2SystemContractsUpgradeBatchNumber()).to.equal(3);
  });

  it("Should commit successfully when batch was reverted and reupgraded", async () => {
    await (await proxyExecutor.revertBatches(2)).wait();
    const timestamp = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    const systemLogs = createSystemLogs();
    systemLogs.push(
      constructL2Log(
        true,
        L2_BOOTLOADER_ADDRESS,
        SYSTEM_LOG_KEYS.EXPECTED_SYSTEM_CONTRACT_UPGRADE_TX_HASH_KEY,
        l2UpgradeTxHash
      )
    );
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch3InfoTwoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 3,
        timestamp,
      },
      systemLogs
    );

    const commitReceipt = await (await proxyExecutor.commitBatches(storedBatch2Info, [batch3InfoTwoUpgradeTx])).wait();

    expect(await proxyGetters.getL2SystemContractsUpgradeBatchNumber()).to.equal(3);
    const commitment = commitReceipt.events[0].args.commitment;
    const newBatchStoredInfo = getBatchStoredInfo(batch3InfoTwoUpgradeTx, commitment);
    await makeExecutedEqualCommitted(proxyExecutor, storedBatch2Info, [newBatchStoredInfo], []);

    storedBatch2Info = newBatchStoredInfo;
  });

  it("Should successfully commit a sequential upgrade", async () => {
    expect(await proxyGetters.getL2SystemContractsUpgradeBatchNumber()).to.equal(0);
    await (
      await executeUpgrade(chainId, proxyGetters, stateTransition, {
        newProtocolVersion: 5 + 1 + initialProtocolVersion,
        l2ProtocolUpgradeTx: noopUpgradeTransaction,
      })
    ).wait();

    const timestamp = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    const systemLogs = createSystemLogs();
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch4InfoTwoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 4,
        timestamp,
      },
      systemLogs
    );

    const commitReceipt = await (await proxyExecutor.commitBatches(storedBatch2Info, [batch4InfoTwoUpgradeTx])).wait();
    const commitment = commitReceipt.events[0].args.commitment;
    const newBatchStoredInfo = getBatchStoredInfo(batch4InfoTwoUpgradeTx, commitment);

    expect(await proxyGetters.getL2SystemContractsUpgradeBatchNumber()).to.equal(0);

    await makeExecutedEqualCommitted(proxyExecutor, storedBatch2Info, [newBatchStoredInfo], []);

    storedBatch2Info = newBatchStoredInfo;

    expect(await proxyGetters.getL2SystemContractsUpgradeBatchNumber()).to.equal(0);
  });

  it("Should successfully commit custom upgrade", async () => {
    const upgradeReceipt = await (
      await executeCustomUpgrade(chainId, proxyGetters, stateTransition, {
        newProtocolVersion: 6 + 1 + initialProtocolVersion,
        l2ProtocolUpgradeTx: noopUpgradeTransaction,
      })
    ).wait();
    const customUpgradeFactory = await hardhat.ethers.getContractFactory("CustomUpgradeTest");

    const upgradeEvents = upgradeReceipt.logs.map((log) => {
      // Not all events can be parsed there, but we don't care about them
      try {
        const event = customUpgradeFactory.interface.parseLog(log);
        const parsedArgs = event.args;
        return {
          name: event.name,
          args: parsedArgs,
        };
      } catch (_) {
        // @ts-ignore
      }
    });

    const timestamp = (await hardhat.ethers.provider.getBlock("latest")).timestamp;
    const systemLogs = createSystemLogs();
    systemLogs[SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY] = constructL2Log(
      true,
      L2_SYSTEM_CONTEXT_ADDRESS,
      SYSTEM_LOG_KEYS.PREV_BATCH_HASH_KEY,
      ethers.utils.hexlify(storedBatch2Info.batchHash)
    );

    const batch5InfoTwoUpgradeTx = await buildCommitBatchInfoWithCustomLogs(
      storedBatch2Info,
      {
        batchNumber: 5,
        timestamp,
      },
      systemLogs
    );

    const commitReceipt = await (await proxyExecutor.commitBatches(storedBatch2Info, [batch5InfoTwoUpgradeTx])).wait();
    const commitment = commitReceipt.events[0].args.commitment;
    const newBatchStoredInfo = getBatchStoredInfo(batch5InfoTwoUpgradeTx, commitment);

    await makeExecutedEqualCommitted(proxyExecutor, storedBatch2Info, [newBatchStoredInfo], []);

    storedBatch2Info = newBatchStoredInfo;

    expect(upgradeEvents[1].name).to.equal("Test");
  });
});

type CommitBatchInfoWithTimestamp = Partial<CommitBatchInfo> & {
  batchNumber: BigNumberish;
};

async function buildCommitBatchInfo(
  prevInfo: StoredBatchInfo,
  info: CommitBatchInfoWithTimestamp
): Promise<CommitBatchInfo> {
  const timestamp = info.timestamp || (await hardhat.ethers.provider.getBlock("latest")).timestamp;
  const systemLogs = createSystemLogs(info.priorityOperationsHash, info.numberOfLayer1Txs, prevInfo.batchHash);
  systemLogs[SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY] = constructL2Log(
    true,
    L2_SYSTEM_CONTEXT_ADDRESS,
    SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY,
    packBatchTimestampAndBatchTimestamp(timestamp, timestamp)
  );

  return {
    timestamp,
    indexRepeatedStorageChanges: 0,
    newStateRoot: ethers.utils.randomBytes(32),
    numberOfLayer1Txs: 0,
    priorityOperationsHash: EMPTY_STRING_KECCAK,
    systemLogs: ethers.utils.hexConcat(systemLogs),
    totalL2ToL1Pubdata: ethers.constants.HashZero,
    bootloaderHeapInitialContentsHash: ethers.utils.randomBytes(32),
    eventsQueueStateHash: ethers.utils.randomBytes(32),
    ...info,
  };
}

async function buildCommitBatchInfoWithCustomLogs(
  prevInfo: StoredBatchInfo,
  info: CommitBatchInfoWithTimestamp,
  systemLogs: string[]
): Promise<CommitBatchInfo> {
  const timestamp = info.timestamp || (await hardhat.ethers.provider.getBlock("latest")).timestamp;
  systemLogs[SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY] = constructL2Log(
    true,
    L2_SYSTEM_CONTEXT_ADDRESS,
    SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY,
    packBatchTimestampAndBatchTimestamp(timestamp, timestamp)
  );

  return {
    timestamp,
    indexRepeatedStorageChanges: 0,
    newStateRoot: ethers.utils.randomBytes(32),
    numberOfLayer1Txs: 0,
    priorityOperationsHash: EMPTY_STRING_KECCAK,
    systemLogs: ethers.utils.hexConcat(systemLogs),
    totalL2ToL1Pubdata: ethers.constants.HashZero,
    bootloaderHeapInitialContentsHash: ethers.utils.randomBytes(32),
    eventsQueueStateHash: ethers.utils.randomBytes(32),
    ...info,
  };
}

async function buildCommitBatchInfoWithUpgrade(
  prevInfo: StoredBatchInfo,
  info: CommitBatchInfoWithTimestamp,
  upgradeTxHash: string
): Promise<CommitBatchInfo> {
  const timestamp = info.timestamp || (await hardhat.ethers.provider.getBlock("latest")).timestamp;
  const systemLogs = createSystemLogsWithUpgrade(info.priorityOperationsHash, info.numberOfLayer1Txs, upgradeTxHash);
  systemLogs[SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY] = constructL2Log(
    true,
    L2_SYSTEM_CONTEXT_ADDRESS,
    SYSTEM_LOG_KEYS.PACKED_BATCH_AND_L2_BLOCK_TIMESTAMP_KEY,
    packBatchTimestampAndBatchTimestamp(timestamp, timestamp)
  );

  return {
    timestamp,
    indexRepeatedStorageChanges: 0,
    newStateRoot: ethers.utils.randomBytes(32),
    numberOfLayer1Txs: 0,
    priorityOperationsHash: EMPTY_STRING_KECCAK,
    systemLogs: ethers.utils.hexConcat(systemLogs),
    totalL2ToL1Pubdata: ethers.constants.HashZero,
    bootloaderHeapInitialContentsHash: ethers.utils.randomBytes(32),
    eventsQueueStateHash: ethers.utils.randomBytes(32),
    ...info,
  };
}

function getBatchStoredInfo(commitInfo: CommitBatchInfo, commitment: string): StoredBatchInfo {
  return {
    batchNumber: commitInfo.batchNumber,
    batchHash: commitInfo.newStateRoot,
    indexRepeatedStorageChanges: commitInfo.indexRepeatedStorageChanges,
    numberOfLayer1Txs: commitInfo.numberOfLayer1Txs,
    priorityOperationsHash: commitInfo.priorityOperationsHash,
    l2LogsTreeRoot: ethers.constants.HashZero,
    timestamp: commitInfo.timestamp,
    commitment: commitment,
  };
}

interface L2CanonicalTransaction {
  txType: BigNumberish;
  from: BigNumberish;
  to: BigNumberish;
  gasLimit: BigNumberish;
  gasPerPubdataByteLimit: BigNumberish;
  maxFeePerGas: BigNumberish;
  maxPriorityFeePerGas: BigNumberish;
  paymaster: BigNumberish;
  nonce: BigNumberish;
  value: BigNumberish;
  // In the future, we might want to add some
  // new fields to the struct. The `txData` struct
  // is to be passed to account and any changes to its structure
  // would mean a breaking change to these accounts. In order to prevent this,
  // we should keep some fields as "reserved".
  // It is also recommended that their length is fixed, since
  // it would allow easier proof integration (in case we will need
  // some special circuit for preprocessing transactions).
  reserved: [BigNumberish, BigNumberish, BigNumberish, BigNumberish];
  data: BytesLike;
  signature: BytesLike;
  factoryDeps: BigNumberish[];
  paymasterInput: BytesLike;
  // Reserved dynamic type for the future use-case. Using it should be avoided,
  // But it is still here, just in case we want to enable some additional functionality.
  reservedDynamic: BytesLike;
}

function buildL2CanonicalTransaction(tx: Partial<L2CanonicalTransaction>): L2CanonicalTransaction {
  return {
    txType: SYSTEM_UPGRADE_TX_TYPE,
    from: ethers.constants.AddressZero,
    to: ethers.constants.AddressZero,
    gasLimit: 5000000,
    gasPerPubdataByteLimit: REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT,
    maxFeePerGas: 0,
    maxPriorityFeePerGas: 0,
    paymaster: 0,
    nonce: 0,
    value: 0,
    reserved: [0, 0, 0, 0],
    data: "0x",
    signature: "0x",
    factoryDeps: [],
    paymasterInput: "0x",
    reservedDynamic: "0x",
    ...tx,
  };
}

interface VerifierParams {
  recursionNodeLevelVkHash: BytesLike;
  recursionLeafLevelVkHash: BytesLike;
  recursionCircuitsSetVksHash: BytesLike;
}

function buildVerifierParams(params: Partial<VerifierParams>): VerifierParams {
  return {
    recursionNodeLevelVkHash: ethers.constants.HashZero,
    recursionLeafLevelVkHash: ethers.constants.HashZero,
    recursionCircuitsSetVksHash: ethers.constants.HashZero,
    ...params,
  };
}

interface ProposedUpgrade {
  // The tx for the upgrade call to the l2 system upgrade contract
  l2ProtocolUpgradeTx: L2CanonicalTransaction;
  factoryDeps: BytesLike[];
  executeUpgradeTx: boolean;
  bootloaderHash: BytesLike;
  defaultAccountHash: BytesLike;
  verifier: string;
  verifierParams: VerifierParams;
  l1ContractsUpgradeCalldata: BytesLike;
  postUpgradeCalldata: BytesLike;
  upgradeTimestamp: ethers.BigNumber;
  newProtocolVersion: BigNumberish;
}

type PartialProposedUpgrade = Partial<ProposedUpgrade>;

function buildProposeUpgrade(proposedUpgrade: PartialProposedUpgrade): ProposedUpgrade {
  const newProtocolVersion = proposedUpgrade.newProtocolVersion || 0;
  return {
    l2ProtocolUpgradeTx: buildL2CanonicalTransaction({ nonce: newProtocolVersion }),
    executeUpgradeTx: false,
    bootloaderHash: ethers.constants.HashZero,
    defaultAccountHash: ethers.constants.HashZero,
    verifier: ethers.constants.AddressZero,
    verifierParams: buildVerifierParams({}),
    l1ContractsUpgradeCalldata: "0x",
    postUpgradeCalldata: "0x",
    upgradeTimestamp: ethers.constants.Zero,
    factoryDeps: [],
    newProtocolVersion,
    ...proposedUpgrade,
  };
}

async function executeUpgrade(
  chainId: BigNumberish,
  proxyGetters: GettersFacet,
  stateTransition: ZkSyncStateTransition,
  partialUpgrade: Partial<ProposedUpgrade>,
  contractFactory?: ethers.ethers.ContractFactory
) {
  if (partialUpgrade.newProtocolVersion == null) {
    const newVersion = (await proxyGetters.getProtocolVersion()).add(1);
    partialUpgrade.newProtocolVersion = newVersion;
  }
  const upgrade = buildProposeUpgrade(partialUpgrade);

  const defaultUpgradeFactory = contractFactory
    ? contractFactory
    : await hardhat.ethers.getContractFactory("DefaultUpgrade");

  const defaultUpgrade = await defaultUpgradeFactory.deploy();
  const diamondUpgradeInit = DefaultUpgradeFactory.connect(defaultUpgrade.address, defaultUpgrade.signer);

  const upgradeCalldata = diamondUpgradeInit.interface.encodeFunctionData("upgrade", [upgrade]);

  const diamondCutData = diamondCut([], diamondUpgradeInit.address, upgradeCalldata);

  const oldProtocolVersion = await proxyGetters.getProtocolVersion();
  // This promise will be handled in the tests
  (
    await stateTransition.setNewVersionUpgrade(diamondCutData, oldProtocolVersion, partialUpgrade.newProtocolVersion)
  ).wait();
  return stateTransition.upgradeChainFromVersion(chainId, oldProtocolVersion, diamondCutData);
}

// we rollback the protocolVersion ( we don't clear the upgradeHash mapping, but thats ok)
async function rollBackToVersion(
  protocolVersion: string,
  stateTransition: ZkSyncStateTransition,
  partialUpgrade: Partial<ProposedUpgrade>
) {
  partialUpgrade.newProtocolVersion = protocolVersion;

  const upgrade = buildProposeUpgrade(partialUpgrade);

  const defaultUpgradeFactory = await hardhat.ethers.getContractFactory("DefaultUpgrade");

  const defaultUpgrade = await defaultUpgradeFactory.deploy();
  const diamondUpgradeInit = DefaultUpgradeFactory.connect(defaultUpgrade.address, defaultUpgrade.signer);

  const upgradeCalldata = diamondUpgradeInit.interface.encodeFunctionData("upgrade", [upgrade]);

  const diamondCutData = diamondCut([], diamondUpgradeInit.address, upgradeCalldata);

  // This promise will be handled in the tests
  (
    await stateTransition.setNewVersionUpgrade(
      diamondCutData,
      (parseInt(protocolVersion) - 1).toString(),
      protocolVersion
    )
  ).wait();
}

async function executeCustomUpgrade(
  chainId: BigNumberish,
  proxyGetters: GettersFacet,
  stateTransition: ZkSyncStateTransition,
  partialUpgrade: Partial<ProposedUpgrade>,
  contractFactory?: ethers.ethers.ContractFactory
) {
  if (partialUpgrade.newProtocolVersion == null) {
    const newVersion = (await proxyGetters.getProtocolVersion()).add(1);
    partialUpgrade.newProtocolVersion = newVersion;
  }
  const upgrade = buildProposeUpgrade(partialUpgrade);

  const upgradeFactory = contractFactory
    ? contractFactory
    : await hardhat.ethers.getContractFactory("CustomUpgradeTest");

  const customUpgrade = await upgradeFactory.deploy();
  const diamondUpgradeInit = CustomUpgradeTestFactory.connect(customUpgrade.address, customUpgrade.signer);

  const upgradeCalldata = diamondUpgradeInit.interface.encodeFunctionData("upgrade", [upgrade]);

  const diamondCutData = diamondCut([], diamondUpgradeInit.address, upgradeCalldata);
  const oldProtocolVersion = await proxyGetters.getProtocolVersion();

  // This promise will be handled in the tests
  (
    await stateTransition.setNewVersionUpgrade(diamondCutData, oldProtocolVersion, partialUpgrade.newProtocolVersion)
  ).wait();
  return stateTransition.upgradeChainFromVersion(chainId, oldProtocolVersion, diamondCutData);
}

async function makeExecutedEqualCommitted(
  proxyExecutor: ExecutorFacet,
  prevBatchInfo: StoredBatchInfo,
  batchesToProve: StoredBatchInfo[],
  batchesToExecute: StoredBatchInfo[]
) {
  batchesToExecute = [...batchesToProve, ...batchesToExecute];

  await (
    await proxyExecutor.proveBatches(prevBatchInfo, batchesToProve, {
      recursiveAggregationInput: [],
      serializedProof: [],
    })
  ).wait();

  await (await proxyExecutor.executeBatches(batchesToExecute)).wait();
}