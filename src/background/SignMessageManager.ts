import * as events from 'events';
import { AppState } from '../lib/MemStore';
import PopupManager from '../background/PopupManager';
import { encodeBase64 } from 'tweetnacl-ts';
import * as nacl from 'tweetnacl-ts';
import { encodeBase16 } from 'casper-client-sdk';

const ed25519Key = {
  prefix: '01',
  length: 32
};

const secp256k1Key = {
  prefix: '02',
  length: 33
};

type SignMessageStatus = 'unsigned' | 'signed' | 'rejected';

export interface SignMessage {
  id: number;
  data: string;
  rawSig?: string;
  signPublicKeyBase64?: string; // the public key used to sign the deploy
  time: number;
  status: SignMessageStatus;
  errMsg?: string;
}

/**
 * Sign Message Manager
 *
 * Algorithm:
 *    1. Injected script call `SignMessageManager.addUnsignedMessageAsync`, we return a Promise, inside the Promise, we will
 *       construct a message and assign it a unique id msgId and then we set up a event listen for `${msgId}:finished`.
 *       Resolve or reject when the event emits.
 *    2. Popup call `SignMessageManager.{rejectMsg|approveMsg}` either to reject or commit the signature request,
 *       and both methods will fire a event `${msgId}:finished`, which is listened by step 1.
 */
export default class SignMessageManager extends events.EventEmitter {
  private messages: SignMessage[];
  private nextId: number;
  private popupManager: PopupManager;

  constructor(private appState: AppState) {
    super();
    this.messages = [];
    this.nextId = Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
    this.popupManager = new PopupManager();
  }

  public addUnsignedMessageBase16Async(
    rawMessageBase16: string,
    publicKeyBase64?: string
  ) {
    return new Promise((resolve, reject) => {
      const msgId = this.addUnsignedMessage(rawMessageBase16, publicKeyBase64);
      this.popupManager.openPopup('sign');
      // await finished, listen to finish event, which will be fired by `rejectMsg` or `signMsg`.
      this.once(`${msgId}:finished`, data => {
        switch (data.status) {
          case 'signed':
            return resolve(data.rawSig);
          case 'rejected':
            return reject(
              new Error(data.errMsg ?? 'User denied message signature.')
            );
          default:
            return reject(
              new Error(
                `Message Signature: Unknown problem: ${data.toString()}`
              )
            );
        }
      });
    });
  }

  /**
   * Retrieve the active public key .
   * @returns {string} Hex-encoded public key with algorithm prefix.
   */
  public getActivePublicKey() {
    return new Promise<string>((resolve, reject) => {
      let publicKeyBytes = this.appState.selectedUserAccount?.signKeyPair
        .publicKey;
      if (!this.appState.connectionStatus) {
        return reject(new Error('Please connect to the Signer first.'));
      } else if (publicKeyBytes === undefined) {
        return reject(new Error('Please create an account first.'));
      }

      switch (publicKeyBytes.length) {
        case ed25519Key.length:
          return resolve(ed25519Key.prefix + encodeBase16(publicKeyBytes));
        case secp256k1Key.length:
          return resolve(secp256k1Key.prefix + encodeBase16(publicKeyBytes));
        default:
          return reject(new Error('Key was not of expected format!'));
      }
    });
  }

  // return base64 encoded public key of the current selected account only if connected
  public getSelectedPublicKeyBase64() {
    return new Promise((resolve, reject) => {
      let publicKey = this.appState.selectedUserAccount?.signKeyPair.publicKey;
      if (!this.appState.connectionStatus) {
        return reject(new Error('Please connect to the Signer first.'));
      } else if (publicKey === undefined) {
        return reject(new Error('Please create an account first.'));
      }
      // ! syntax to satisfy compiler as undefined public key is handled above
      return resolve(encodeBase64(publicKey!));
    });
  }

  // Reject signature request
  public rejectMsg(msgId: number) {
    const msg = this.getMsg(msgId);
    msg.status = 'rejected';
    msg.errMsg = 'User denied message signature.';
    this.saveAndEmitEventIfNeeded(msg);
    this.popupManager.closePopup();
  }

  // Approve signature request
  public approveMsg(msgId: number) {
    const msg = this.getMsg(msgId);
    if (!this.appState.selectedUserAccount) {
      throw new Error(`Please select the account first`);
    }
    let activePublicKey = encodeBase64(
      this.appState.selectedUserAccount.signKeyPair.publicKey
    );

    // before generating deployHash, we need set account public key hash,
    // so if an user switch to another key, reject the signature request
    if (
      msg.signPublicKeyBase64 &&
      activePublicKey !== msg.signPublicKeyBase64
    ) {
      msg.status = 'rejected';
      msg.errMsg = `You have changed the active key, please resend the signature request`;
      this.saveAndEmitEventIfNeeded(msg);
      return;
    }

    let sig = nacl.sign_detached(
      Buffer.from(msg.data, 'hex'),
      this.appState.selectedUserAccount.signKeyPair.secretKey
    );

    msg.rawSig = nacl.encodeBase64(sig);
    msg.status = 'signed';
    this.saveAndEmitEventIfNeeded(msg);
  }

  private createId() {
    this.nextId = this.nextId % Number.MAX_SAFE_INTEGER;
    return this.nextId++;
  }

  private saveAndEmitEventIfNeeded(msg: SignMessage) {
    let status = msg.status;
    this.updateMsg(msg);
    if (status === 'rejected' || status === 'signed') {
      // fire finished event, so that the Promise can resolve and return result to RPC caller
      this.emit(`${msg.id}:finished`, msg);
    }
  }

  private updateMsg(msg: SignMessage) {
    const index = this.messages.findIndex(message => message.id === msg.id);
    if (index === -1) {
      throw new Error(`Could not find message with id: ${msg.id}`);
    }
    this.messages[index] = msg;
    this.updateAppState();
  }

  /**
   * Construct a SignMessage and add it to AppState.toSignMessages
   *
   * @param rawMessageBase16: the base16 encoded message that plugin received to sign
   * @param publicKeyBase64: the base64 encoded public key used to sign the deploy,  if set, we will check whether it is the same as the active key for signing the message, otherwise, we won't check.
   * @throws Error if publicKeyBase64 is not the same as the key that Signer used to sign the message
   */
  private addUnsignedMessage(
    rawMessageBase16: string,
    publicKeyBase64?: string
  ) {
    const time = new Date().getTime();
    const msgId = this.createId();
    const msg: SignMessage = {
      id: msgId,
      data: rawMessageBase16,
      signPublicKeyBase64: publicKeyBase64,
      time: time,
      status: 'unsigned'
    };

    // Add msg to local cached message and push it to UI if necessary.
    this.messages.push(msg);
    this.updateAppState();
    return msgId;
  }

  // Update toSignMessage, and it will trigger the autorun in background.ts, and send updated state to Popup
  private updateAppState() {
    const unsignedMessages = this.messages.filter(
      msg => msg.status === 'unsigned'
    );
    this.appState.toSignMessages.replace(unsignedMessages);
  }

  /**
   * Find msg by msgId
   * @param msgId
   * @throws Error if there is no message with the msgId
   */
  private getMsg(msgId: number): SignMessage {
    let signMessage = this.messages.find(msg => msg.id === msgId);
    if (signMessage === undefined) {
      throw new Error(`Could not find message with id: ${msgId}`);
    }
    return signMessage;
  }
}
