/**
 * `@graft/vault` — envelope encryption for the credentials Graft holds, over a keyring seam with
 * two backings (ADR 0002): the local AES keyring here, the KMS keyring in the private package.
 */
export {
  createLocalKeyring,
  DATA_KEY_BYTES,
  type DataKey,
  type EncryptionContext,
  type Keyring,
  LOCAL_KEYRING_ID,
  MIN_LOCAL_KEYRING_SECRET_LENGTH,
} from "./keyring";
export {
  CredentialCiphertextError,
  type CredentialFields,
  type CredentialScope,
  CredentialScopeMismatchError,
  CredentialShapeError,
  type CredentialVault,
  createCredentialVault,
  type EncryptOnlyVault,
} from "./vault";
