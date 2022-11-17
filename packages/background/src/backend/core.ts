import { validateMnemonic as _validateMnemonic } from "bip39";
import { ethers } from "ethers";
import type {
  Commitment,
  SendOptions,
  SimulateTransactionConfig,
} from "@solana/web3.js";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { KeyringStoreState } from "@coral-xyz/recoil";
import { makeDefaultNav } from "@coral-xyz/recoil";
import {
  BACKEND_EVENT,
  Blockchain,
  NOTIFICATION_APPROVED_ORIGINS_UPDATE,
  NOTIFICATION_AUTO_LOCK_SECS_UPDATED,
  NOTIFICATION_BLOCKCHAIN_DISABLED,
  NOTIFICATION_BLOCKCHAIN_ENABLED,
  NOTIFICATION_BLOCKCHAIN_SETTINGS_UPDATED,
  NOTIFICATION_DARK_MODE_UPDATED,
  NOTIFICATION_DEVELOPER_MODE_UPDATED,
  NOTIFICATION_KEYNAME_UPDATE,
  NOTIFICATION_KEYRING_DERIVED_WALLET,
  NOTIFICATION_KEYRING_IMPORTED_SECRET_KEY,
  NOTIFICATION_KEYRING_KEY_DELETE,
  NOTIFICATION_KEYRING_STORE_CREATED,
  NOTIFICATION_KEYRING_STORE_LOCKED,
  NOTIFICATION_KEYRING_STORE_RESET,
  NOTIFICATION_KEYRING_STORE_UNLOCKED,
  NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
  NOTIFICATION_XNFT_PREFERENCE_UPDATED,
  deserializeTransaction,
  FEATURE_GATES_MAP,
  XnftPreference,
} from "@coral-xyz/common";
import type {
  KeyringInit,
  DerivationPath,
  EventEmitter,
  KeyringType,
} from "@coral-xyz/common";
import type { Nav } from "./store";
import * as store from "./store";
import { BlockchainKeyring } from "./keyring/blockchain";
import { KeyringStore } from "./keyring";
import type { SolanaConnectionBackend } from "./solana-connection";
import type { EthereumConnectionBackend } from "./ethereum-connection";
import { DEFAULT_DARK_MODE } from "./store";
import type { SolanaSettings } from "./store/preferences";

const { base58: bs58 } = ethers.utils;

export function start(
  events: EventEmitter,
  solanaB: SolanaConnectionBackend,
  ethereumB: EthereumConnectionBackend
) {
  return new Backend(events, solanaB, ethereumB);
}

export class Backend {
  private keyringStore: KeyringStore;
  private solanaConnectionBackend: SolanaConnectionBackend;
  private ethereumConnectionBackend: EthereumConnectionBackend;
  private events: EventEmitter;

  constructor(
    events: EventEmitter,
    solanaB: SolanaConnectionBackend,
    ethereumB: EthereumConnectionBackend
  ) {
    this.keyringStore = new KeyringStore(events);
    this.solanaConnectionBackend = solanaB;
    this.ethereumConnectionBackend = ethereumB;
    this.events = events;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Solana Provider.
  ///////////////////////////////////////////////////////////////////////////////

  async solanaSignAndSendTx(
    txStr: string,
    walletAddress: string,
    options?: SendOptions
  ): Promise<string> {
    // Sign the transaction.
    const signature = await this.solanaSignTransaction(txStr, walletAddress);
    const pubkey = new PublicKey(walletAddress);
    const tx = deserializeTransaction(txStr);
    tx.addSignature(pubkey, Buffer.from(bs58.decode(signature)));

    // Send it to the network.
    const solanaSettings = (await this.blockchainSettingsRead(
      Blockchain.SOLANA
    )) as SolanaSettings;
    const preflightCommitment = solanaSettings
      ? solanaSettings.commitment
      : "confirmed";
    return await this.solanaConnectionBackend.sendRawTransaction(
      tx.serialize(),
      options ?? {
        skipPreflight: false,
        preflightCommitment,
      }
    );
  }

  async solanaSignAllTransactions(
    txs: Array<string>,
    walletAddress: string
  ): Promise<Array<string>> {
    const signed: Array<string> = [];
    for (let k = 0; k < txs.length; k += 1) {
      signed.push(await this.solanaSignTransaction(txs[k], walletAddress));
    }
    return signed;
  }

  // Returns the signature.
  async solanaSignTransaction(
    txStr: string,
    walletAddress: string
  ): Promise<string> {
    const tx = deserializeTransaction(txStr);
    const message = tx.message.serialize();
    const txMessage = bs58.encode(message);
    const blockchainKeyring = this.keyringStore.keyringForBlockchain(
      Blockchain.SOLANA
    );
    return await blockchainKeyring.signTransaction(txMessage, walletAddress);
  }

  async solanaSignMessage(msg: string, walletAddress: string): Promise<string> {
    const blockchainKeyring = this.keyringStore.keyringForBlockchain(
      Blockchain.SOLANA
    );
    return await blockchainKeyring.signMessage(msg, walletAddress);
  }

  async solanaSimulate(
    txStr: string,
    walletAddress: string,
    includeAccounts?: boolean | Array<string>
  ): Promise<any> {
    const tx = deserializeTransaction(txStr);
    const signersOrConf =
      "message" in tx
        ? ({
            accounts: {
              encoding: "base64",
              addresses: [new PublicKey(walletAddress).toBase58()],
            },
          } as SimulateTransactionConfig)
        : undefined;

    return await this.solanaConnectionBackend.simulateTransaction(
      tx,
      signersOrConf,
      typeof includeAccounts === "boolean"
        ? includeAccounts
        : includeAccounts && includeAccounts.map((a) => new PublicKey(a))
    );
  }

  solanaDisconnect() {
    // todo
    return SUCCESS_RESPONSE;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Solana.
  ///////////////////////////////////////////////////////////////////////////////

  async solanaRecentBlockhash(commitment?: Commitment): Promise<string> {
    const { blockhash } = await this.solanaConnectionBackend.getLatestBlockhash(
      commitment
    );
    return blockhash;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Ethereum provider.
  ///////////////////////////////////////////////////////////////////////////////

  async ethereumSignTransaction(
    serializedTx: string,
    walletAddress: string
  ): Promise<string> {
    const blockchainKeyring = this.keyringStore.keyringForBlockchain(
      Blockchain.ETHEREUM
    );
    return await blockchainKeyring.signTransaction(serializedTx, walletAddress);
  }

  async ethereumSignAndSendTransaction(
    serializedTx: string,
    walletAddress: string
  ): Promise<string> {
    const signedTx = await this.ethereumSignTransaction(
      serializedTx,
      walletAddress
    );
    return (await this.ethereumConnectionBackend.sendTransaction(signedTx))
      .hash;
  }

  async ethereumSignMessage(msg: string, walletAddress: string) {
    const blockchainKeyring = this.keyringStore.keyringForBlockchain(
      Blockchain.ETHEREUM
    );
    return await blockchainKeyring.signMessage(msg, walletAddress);
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Misc
  ///////////////////////////////////////////////////////////////////////////////

  // Method for signing messages from a specific wallet for a specific blockchain
  // without the requirement to initialise a keystore. Used during onboarding.
  async signMessageForWallet(
    blockchain: Blockchain,
    msg: string,
    derivationPath: DerivationPath,
    accountIndex: number,
    publicKey: string,
    mnemonic?: string
  ) {
    const blockchainKeyring = {
      [Blockchain.SOLANA]: BlockchainKeyring.solana,
      [Blockchain.ETHEREUM]: BlockchainKeyring.ethereum,
    }[blockchain]();

    if (mnemonic) {
      blockchainKeyring.initFromMnemonic(mnemonic, derivationPath, [
        accountIndex,
      ]);
    } else {
      if (!publicKey) {
        throw new Error("missing public key");
      }
      blockchainKeyring.initFromLedger([
        {
          path: derivationPath,
          account: accountIndex,
          publicKey,
        },
      ]);
      if (blockchain === Blockchain.SOLANA) {
        // Setup a dummy transaction using the memo program for signing. This is
        // necessary because the Solana Ledger app does not support signMessage.
        const tx = new Transaction();
        tx.add(
          new TransactionInstruction({
            programId: new PublicKey(publicKey),
            keys: [],
            data: Buffer.from(bs58.decode(msg)),
          })
        );
        tx.feePayer = new PublicKey(publicKey);
        // Not actually needed as it's not transmitted to the network
        tx.recentBlockhash = tx.feePayer.toString();
        // Call the signTransaction method on Ledger
        return await blockchainKeyring.signTransaction(
          bs58.encode(tx.serializeMessage()),
          publicKey
        );
      }
    }

    return await blockchainKeyring.signMessage(msg, publicKey);
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Keyring.
  ///////////////////////////////////////////////////////////////////////////////

  // Creates a brand new keyring store. Should be run once on initializtion.
  async keyringStoreCreate(
    username: string,
    password: string,
    keyringInit: KeyringInit
  ): Promise<string> {
    await this.keyringStore.init(username, password, keyringInit);

    const data = {};
    for (const blockchain of await this.enabledBlockchainsRead()) {
      data[blockchain] = await this.blockchainSettingsRead(blockchain);
    }

    // Notify all listeners.
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_STORE_CREATED,
      data,
    });

    return SUCCESS_RESPONSE;
  }

  async keyringStoreCheckPassword(password: string): Promise<boolean> {
    return await this.keyringStore.checkPassword(password);
  }

  async keyringStoreUnlock(password: string): Promise<string> {
    await this.keyringStore.tryUnlock(password);

    const data = {};
    for (const blockchain of await this.enabledBlockchainsRead()) {
      data[blockchain] = await this.blockchainSettingsRead(blockchain);
    }

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_STORE_UNLOCKED,
      data,
    });

    return SUCCESS_RESPONSE;
  }

  keyringStoreLock() {
    this.keyringStore.lock();
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_STORE_LOCKED,
    });
    return SUCCESS_RESPONSE;
  }

  async keyringStoreState(): Promise<KeyringStoreState> {
    return await this.keyringStore.state();
  }

  keyringStoreKeepAlive(): string {
    this.keyringStore.keepAlive();
    return SUCCESS_RESPONSE;
  }

  // Returns all pubkeys available for signing.
  async keyringStoreReadAllPubkeys(): Promise<any> {
    const publicKeys = await this.keyringStore.publicKeys();
    const namedPublicKeys = {};
    for (const [blockchain, blockchainKeyring] of Object.entries(publicKeys)) {
      namedPublicKeys[blockchain] = {};
      for (const [keyring, publicKeys] of Object.entries(blockchainKeyring)) {
        if (!namedPublicKeys[blockchain][keyring]) {
          namedPublicKeys[blockchain][keyring] = [];
        }
        for (const publicKey of publicKeys) {
          namedPublicKeys[blockchain][keyring].push({
            publicKey,
            name: await store.getKeyname(publicKey),
          });
        }
      }
    }
    return namedPublicKeys;
  }

  async keyringDeriveWallet(blockchain: Blockchain): Promise<string> {
    const [pubkey, name] = await this.keyringStore.deriveNextKey(blockchain);
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_DERIVED_WALLET,
      data: {
        blockchain,
        publicKey: pubkey.toString(),
        name,
      },
    });
    // Return the newly created key.
    return pubkey.toString();
  }

  async keynameRead(publicKey: string): Promise<string> {
    const keyname = await store.getKeyname(publicKey);
    return keyname;
  }

  async keynameUpdate(publicKey: string, newName: string): Promise<string> {
    await store.setKeyname(publicKey, newName);
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYNAME_UPDATE,
      data: {
        publicKey,
        name: newName,
      },
    });
    return SUCCESS_RESPONSE;
  }

  async keyringKeyDelete(
    blockchain: Blockchain,
    publicKey: string
  ): Promise<string> {
    const keyring = this.keyringStore.keyringForBlockchain(blockchain);

    // If we're removing the currently active key then we need to update it
    // first.
    if (keyring.getActiveWallet() === publicKey) {
      // Find remaining public keys
      const nextPublicKey = Object.values(keyring.publicKeys())
        .flat()
        .find((k) => k !== keyring.getActiveWallet());
      if (!nextPublicKey) {
        throw new Error("cannot delete last public key");
      }
      // Set the first to be it to be the new active wallet
      keyring.activeWalletUpdate(nextPublicKey);
    }

    await this.keyringStore.keyDelete(blockchain, publicKey);

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_KEY_DELETE,
      data: {
        blockchain,
        deletedPublicKey: publicKey,
      },
    });

    return SUCCESS_RESPONSE;
  }

  async usernameRead(): Promise<string> {
    const { username = "" } = await store.getWalletData();
    return username;
  }

  async passwordUpdate(
    currentPassword: string,
    newPassword: string
  ): Promise<string> {
    await this.keyringStore.passwordUpdate(currentPassword, newPassword);
    return SUCCESS_RESPONSE;
  }

  async importSecretKey(
    blockchain: Blockchain,
    secretKey: string,
    name: string
  ): Promise<string> {
    const [publicKey, _name] = await this.keyringStore.importSecretKey(
      blockchain,
      secretKey,
      name
    );
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_IMPORTED_SECRET_KEY,
      data: {
        blockchain,
        publicKey,
        name: _name,
      },
    });
    return publicKey;
  }

  keyringExportSecretKey(password: string, pubkey: string): string {
    return this.keyringStore.exportSecretKey(password, pubkey);
  }

  keyringExportMnemonic(password: string): string {
    return this.keyringStore.exportMnemonic(password);
  }

  async keyringAutolockRead(): Promise<number> {
    const data = await store.getWalletData();
    return data.autoLockSecs;
  }

  async keyringAutolockUpdate(autoLockSecs: number): Promise<string> {
    await this.keyringStore.autoLockUpdate(autoLockSecs);
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_AUTO_LOCK_SECS_UPDATED,
      data: {
        autoLockSecs,
      },
    });
    return SUCCESS_RESPONSE;
  }

  keyringReset(): string {
    this.keyringStore.reset();
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_KEYRING_STORE_RESET,
    });
    return SUCCESS_RESPONSE;
  }

  async ledgerImport(
    blockchain: Blockchain,
    dPath: string,
    account: number,
    pubkey: string
  ) {
    await this.keyringStore.ledgerImport(blockchain, dPath, account, pubkey);
    return SUCCESS_RESPONSE;
  }

  validateMnemonic(mnemonic: string): boolean {
    return _validateMnemonic(mnemonic);
  }

  async mnemonicCreate(strength: number): Promise<string> {
    return this.keyringStore.createMnemonic(strength);
  }

  keyringTypeRead(): KeyringType {
    return this.keyringStore.hasMnemonic() ? "mnemonic" : "ledger";
  }

  async previewPubkeys(
    blockchain: Blockchain,
    mnemonic: string,
    derivationPath: DerivationPath,
    numberOfAccounts: number
  ) {
    return this.keyringStore.previewPubkeys(
      blockchain,
      mnemonic,
      derivationPath,
      numberOfAccounts
    );
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Backpack Preferences.
  ///////////////////////////////////////////////////////////////////////////////

  async darkModeRead(): Promise<boolean> {
    const state = await this.keyringStoreState();
    if (state === "needs-onboarding") {
      return DEFAULT_DARK_MODE;
    }
    const data = await store.getWalletData();
    return data.darkMode ?? DEFAULT_DARK_MODE;
  }

  async darkModeUpdate(darkMode: boolean): Promise<string> {
    const data = await store.getWalletData();
    await store.setWalletData({
      ...data,
      darkMode,
    });
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_DARK_MODE_UPDATED,
      data: {
        darkMode,
      },
    });
    return SUCCESS_RESPONSE;
  }

  async developerModeRead(): Promise<boolean> {
    const data = await store.getWalletData();
    return data.developerMode ?? false;
  }

  async developerModeUpdate(developerMode: boolean): Promise<string> {
    const data = await store.getWalletData();
    await store.setWalletData({
      ...data,
      developerMode,
    });
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_DEVELOPER_MODE_UPDATED,
      data: {
        developerMode,
      },
    });
    return SUCCESS_RESPONSE;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Origins
  ///////////////////////////////////////////////////////////////////////////////

  async approvedOriginsRead(): Promise<Array<string>> {
    const data = await store.getWalletData();
    return data.approvedOrigins;
  }

  async approvedOriginsUpdate(approvedOrigins: Array<string>): Promise<string> {
    const data = await store.getWalletData();
    await store.setWalletData({
      ...data,
      approvedOrigins,
    });

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_APPROVED_ORIGINS_UPDATE,
      data: {
        approvedOrigins,
      },
    });
    return SUCCESS_RESPONSE;
  }

  async approvedOriginsDelete(origin: string): Promise<string> {
    const data = await store.getWalletData();
    const approvedOrigins = data.approvedOrigins.filter((o) => o !== origin);
    await store.setWalletData({
      ...data,
      approvedOrigins,
    });
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_APPROVED_ORIGINS_UPDATE,
      data: {
        approvedOrigins,
      },
    });
    return SUCCESS_RESPONSE;
  }

  async isApprovedOrigin(origin: string): Promise<boolean> {
    const data = await store.getWalletData();
    if (!data.approvedOrigins) {
      return false;
    }
    const found = data.approvedOrigins.find((o) => o === origin);
    return found !== undefined;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Blockchains
  ///////////////////////////////////////////////////////////////////////////////

  /**
   * Add a new blockchain keyring to the keyring store (i.e. initialize it).
   */
  async blockchainKeyringsAdd(
    blockchain: Blockchain,
    derivationPath: DerivationPath,
    accountIndex: number,
    publicKey?: string
  ): Promise<void> {
    await this.keyringStore.blockchainKeyringAdd(
      blockchain,
      derivationPath,
      accountIndex,
      publicKey
    );
    // Automatically enable the newly added blockchain
    await this.enabledBlockchainsAdd(blockchain);
  }

  /**
   * Return all blockchains that have initialised keyrings, even if they are not
   * enabled.
   */
  async blockchainKeyringsRead(): Promise<Array<Blockchain>> {
    return this.keyringStore.blockchainKeyrings();
  }

  /**
   * Enable a blockchain. The blockchain keyring must be initialized prior to this.
   */
  async enabledBlockchainsAdd(blockchain: Blockchain) {
    const data = await store.getWalletData();
    if (data.enabledBlockchains.includes(blockchain)) {
      throw new Error("blockchain already enabled");
    }

    // Validate that the keyring is initialised before we enable it. This could
    // be done using `this.blockchainKeyringsRead()` but we need the keyring to
    // create a notification with the active wallet later anyway.
    let keyring: BlockchainKeyring;
    try {
      keyring = this.keyringStore.keyringForBlockchain(blockchain);
    } catch (error) {
      throw new Error(`${blockchain} keyring not initialised`);
    }

    const enabledBlockchains = [...data.enabledBlockchains, blockchain];
    await store.setWalletData({
      ...data,
      enabledBlockchains,
    });

    const activeWallet = keyring.getActiveWallet();

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_BLOCKCHAIN_ENABLED,
      data: {
        blockchain,
        enabledBlockchains,
        activeWallet,
      },
    });
  }

  async enabledBlockchainsRemove(blockchain: Blockchain) {
    const data = await store.getWalletData();
    if (!data.enabledBlockchains.includes(blockchain)) {
      throw new Error("blockchain not enabled");
    }
    if (data.enabledBlockchains.length === 1) {
      throw new Error("cannot disable last enabled blockchain");
    }
    const enabledBlockchains = data.enabledBlockchains.filter(
      (b) => b !== blockchain
    );
    await store.setWalletData({
      ...data,
      enabledBlockchains,
    });
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_BLOCKCHAIN_DISABLED,
      data: { blockchain, enabledBlockchains },
    });
  }

  /**
   * Return all the enabled blockchains.
   */
  async enabledBlockchainsRead(): Promise<Array<Blockchain>> {
    const data = await store.getWalletData();
    return data.enabledBlockchains;
  }

  /**
   * Read the settings for a blockchain.
   */
  async blockchainSettingsRead(blockchain: Blockchain) {
    const data = await store.getWalletData();
    return {
      activeWallet: this.blockchainActiveWallets[blockchain],
      ...data[blockchain],
    };
  }

  /**
   * Update the settings for a blockchain.
   */
  async blockchainSettingsUpdate(
    blockchain: Blockchain,
    settings: Record<string, string>
  ) {
    const data = await store.getWalletData();
    const prevSettings = { ...(data[blockchain] || {}) };
    const newSettings = { ...prevSettings, ...settings };
    await store.setWalletData({
      ...data,
      [blockchain]: newSettings,
    });
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_BLOCKCHAIN_SETTINGS_UPDATED,
      data: { prevSettings, newSettings },
    });
    return SUCCESS_RESPONSE;
  }

  async activeWallets(): Promise<Array<string>> {
    const data = await store.getWalletData();
    // TODO remove this when all active wallets are migrated to the blockchain
    // settings
    const blockchainActiveWallets = this.blockchainActiveWallets();
    return (await this.enabledBlockchainsRead()).map((blockchain) => {
      const blockchainSettings = data[blockchain];
      if (blockchainSettings && blockchainSettings.activeWallet) {
        return blockchainSettings.activeWallet;
      }
      return blockchainActiveWallets[blockchain];
    });
  }

  async activeWalletUpdate(
    activeWallet: string,
    blockchain: Blockchain
  ): Promise<string> {
    await this.blockchainSettingsUpdate(blockchain, { activeWallet });
    return SUCCESS_RESPONSE;
  }

  // Map of blockchain to the active public key for that blockchain.
  async blockchainActiveWallets() {
    return Object.fromEntries(
      (await this.activeWallets()).map((publicKey) => {
        return [this.keyringStore.blockchainForPublicKey(publicKey), publicKey];
      })
    );
  }

  async setFeatureGates(gates: FEATURE_GATES_MAP) {
    await store.setFeatureGates(gates);
  }

  async getFeatureGates() {
    return await store.getFeatureGates();
  }

  async setXnftPreferences(xnftId: string, preference: XnftPreference) {
    const currentPreferences = (await store.getXnftPreferences()) || {};
    const updatedPreferences = {
      ...currentPreferences,
      [xnftId]: {
        ...(currentPreferences[xnftId] || {}),
        ...preference,
      },
    };
    await store.setXnftPreferences(updatedPreferences);
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_XNFT_PREFERENCE_UPDATED,
      data: { updatedPreferences },
    });
  }

  async getXnftPreferences() {
    return await store.getXnftPreferences();
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Navigation.
  ///////////////////////////////////////////////////////////////////////////////

  async navigationPush(url: string): Promise<string> {
    let nav = await store.getNav();
    if (!nav) {
      throw new Error("nav not found");
    }
    nav.data[nav.activeTab].urls.push(url);
    await store.setNav(nav);
    url = setSearchParam(url, "nav", "push");

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
      data: {
        url,
      },
    });

    return SUCCESS_RESPONSE;
  }

  async navigationPop(): Promise<string> {
    let nav = await store.getNav();
    if (!nav) {
      throw new Error("nav not found");
    }
    nav.data[nav.activeTab].urls.pop();
    await store.setNav(nav);

    const urls = nav.data[nav.activeTab].urls;
    let url = urls[urls.length - 1];
    url = setSearchParam(url, "nav", "pop");

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
      data: {
        url,
      },
    });

    return SUCCESS_RESPONSE;
  }

  async navigationToRoot(): Promise<string> {
    let nav = await store.getNav();
    if (!nav) {
      throw new Error("nav not found");
    }
    const urls = nav.data[nav.activeTab].urls;
    if (urls.length <= 1) {
      return SUCCESS_RESPONSE;
    }

    let url = urls[0];
    nav.data[nav.activeTab].urls = [url];
    await store.setNav(nav);

    url = setSearchParam(url, "nav", "pop");
    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
      data: {
        url,
      },
    });

    return SUCCESS_RESPONSE;
  }

  async navRead(): Promise<Nav> {
    let nav = await store.getNav();
    if (!nav) {
      await store.setNav(defaultNav);
      nav = defaultNav;
    }
    // @ts-ignore
    return nav;
  }

  async navigationActiveTabUpdate(activeTab: string): Promise<string> {
    const currNav = await store.getNav();
    if (!currNav) {
      throw new Error("invariant violation");
    }
    const nav = {
      ...currNav,
      activeTab,
    };
    await store.setNav(nav);
    const navData = nav.data[activeTab];
    let url = navData.urls[navData.urls.length - 1];
    url = setSearchParam(url, "nav", "tab");

    this.events.emit(BACKEND_EVENT, {
      name: NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
      data: {
        url,
      },
    });

    return SUCCESS_RESPONSE;
  }

  async navigationCurrentUrlUpdate(
    url: string,
    activeTab?: string
  ): Promise<string> {
    // Get the tab nav.
    const currNav = await store.getNav();
    if (!currNav) {
      throw new Error("invariant violation");
    }

    // Update the active tab's nav stack.
    const navData = currNav.data[activeTab ?? currNav.activeTab];
    if (!navData) {
      // We exit gracefully so that we don't crash the app.
      console.error(`navData not found for tab ${activeTab}`);
      return SUCCESS_RESPONSE;
    }
    navData.urls[navData.urls.length - 1] = url;
    currNav.data[activeTab ?? currNav.activeTab] = navData;

    // Save the change.
    await store.setNav(currNav);

    // Only navigate if the user hasn't already moved away from this tab
    // or if the user didn't explicitly send an activeTab
    if (!activeTab || activeTab === currNav.activeTab) {
      // Notify listeners.
      this.events.emit(BACKEND_EVENT, {
        name: NOTIFICATION_NAVIGATION_URL_DID_CHANGE,
        data: {
          url,
          nav: "tab",
        },
      });
    }

    return SUCCESS_RESPONSE;
  }

  async pluginLocalStorageGet(xnftAddress: string, key: string): Promise<any> {
    return await store.LocalStorageDb.get(`${xnftAddress}:${key}`);
  }

  async pluginLocalStoragePut(
    xnftAddress: string,
    key: string,
    value: any
  ): Promise<any> {
    await store.LocalStorageDb.set(`${xnftAddress}:${key}`, value);
    return SUCCESS_RESPONSE;
  }
}

export const SUCCESS_RESPONSE = "success";
const defaultNav = makeDefaultNav();

function setSearchParam(url: string, key: string, value: string): string {
  const [path, search] = url.split("?");
  const searchParams = new URLSearchParams(search);
  searchParams.delete(key);
  searchParams.append(key, value);
  return `${path}?${searchParams.toString()}`;
}
