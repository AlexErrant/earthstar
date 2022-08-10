// @denmo-types="../doc_drivers/indexeddb_types.deno.d.ts"

import { DocAttachment, ShareAddress } from "../../util/doc-types.ts";
import { IReplicaAttachmentDriver } from "../replica-types.ts";

import { Logger } from "../../util/log.ts";
import { deferred } from "https://deno.land/std@0.150.0/async/deferred.ts";
import { EarthstarError, ValidationError } from "../../util/errors.ts";
import { Crypto } from "../../crypto/crypto.ts";
import { randomId } from "../../util/misc.ts";
import { streamToBytes } from "../../util/streams.ts";
const logger = new Logger("replica driver indexeddb", "gold");

const ATTACHMENT_STAGING_STORE = "attachment_staging_index";
const ATTACHMENT_INDEX_STORE = "attachments_index";
const ATTACHMENT_BYTES_STORE = "attachments_bytes";

export class AttachmentDriverIndexedDB implements IReplicaAttachmentDriver {
  private db = deferred<IDBDatabase>();
  private share: ShareAddress;

  constructor(share: ShareAddress) {
    this.share = share;

    // dnt-shim-ignore
    if (!(window as any).indexedDB) {
      throw new EarthstarError("IndexedDB is not supported by this runtime.");
    }

    const request = ((window as any).indexedDB).open(
      `earthstar:share_attachments:${this.share}`,
      1,
    );

    request.onerror = () => {
      logger.error(`Could not open IndexedDB for ${this.share}'s attachments.`);
      logger.error(request.error);
      throw new EarthstarError(
        `Could not open IndexedDB for ${this.share}'s attachments.`,
      );
    };

    request.onupgradeneeded = function () {
      const db = request.result;

      // we're going to store everything in one row.
      db.createObjectStore(ATTACHMENT_BYTES_STORE);
      db.createObjectStore(ATTACHMENT_INDEX_STORE, { keyPath: "id" });
      db.createObjectStore(ATTACHMENT_STAGING_STORE, { keyPath: "id" });
    };

    request.onsuccess = () => {
      this.db.resolve(request.result);
    };
  }

  private getIndexKey(formatName: string, attachmentHash: string) {
    return `${formatName}___${attachmentHash}`;
  }

  async getAttachment(
    formatName: string,
    attachmentHash: string,
  ): Promise<DocAttachment | undefined> {
    const resultDeferred = deferred<DocAttachment | undefined>();

    const indexKey = this.getIndexKey(formatName, attachmentHash);
    const db = await this.db;

    const transaction = db.transaction([
      ATTACHMENT_INDEX_STORE,
    ], "readonly");

    const getKey = transaction.objectStore(ATTACHMENT_INDEX_STORE).get(
      indexKey,
    );

    const blobKeyDeferred = deferred<string>();

    getKey.onerror = () => {
      blobKeyDeferred.reject();
    };

    getKey.onsuccess = () => {
      if (getKey.result === undefined) {
        blobKeyDeferred.reject();
      } else {
        blobKeyDeferred.resolve(getKey.result.blobKey);
      }
    };

    blobKeyDeferred.then((blobKey) => {
      const blobTransaction = db.transaction(
        [ATTACHMENT_BYTES_STORE],
        "readonly",
      );

      const getBlob = blobTransaction.objectStore(ATTACHMENT_BYTES_STORE).get(
        blobKey,
      );

      getBlob.onsuccess = () => {
        const blob = new Blob([getBlob.result]);

        resultDeferred.resolve({
          bytes: async () => new Uint8Array(await blob.arrayBuffer()),
          stream: () =>
            Promise.resolve(
              // Need to do this for Node's sake.
              blob.stream() as unknown as ReadableStream<Uint8Array>,
            ),
        });
      };

      getBlob.onerror = () => {
        // should probably delete the index here...
        resultDeferred.resolve(undefined);
      };
    }).catch(() => {
      resultDeferred.resolve(undefined);
    });

    return resultDeferred;
  }

  async erase(
    formatName: string,
    attachmentHash: string,
  ): Promise<true | ValidationError> {
    const resultDeferred = deferred<true | ValidationError>();

    const indexKey = this.getIndexKey(formatName, attachmentHash);
    const db = await this.db;

    const transaction = db.transaction([
      ATTACHMENT_INDEX_STORE,
    ], "readonly");

    const getKey = transaction.objectStore(ATTACHMENT_INDEX_STORE).get(
      indexKey,
    );

    const blobKeyDeferred = deferred<string>();

    getKey.onerror = () => {
      blobKeyDeferred.reject();
    };

    getKey.onsuccess = () => {
      db.transaction([ATTACHMENT_INDEX_STORE], "readwrite").objectStore(
        ATTACHMENT_INDEX_STORE,
      ).delete(indexKey);

      if (getKey.result === undefined) {
        blobKeyDeferred.reject();
      } else {
        blobKeyDeferred.resolve(getKey.result.blobKey);
      }
    };

    blobKeyDeferred.then((blobKey) => {
      const deleteBlob = db.transaction([ATTACHMENT_BYTES_STORE], "readwrite")
        .objectStore(
          ATTACHMENT_BYTES_STORE,
        ).delete(
          blobKey,
        );

      deleteBlob.onsuccess = () => {
        resultDeferred.resolve(true);
      };

      deleteBlob.onerror = () => {
        // should probably delete the index here...
        resultDeferred.resolve(undefined);
      };
    }).catch(() => {
      resultDeferred.resolve(new ValidationError("No attachment found"));
    });

    return resultDeferred;
  }

  async stage(
    formatName: string,
    attachment: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<
    {
      hash: string;
      size: number;
      commit: () => Promise<void>;
      reject: () => Promise<void>;
    } | ValidationError
  > {
    // How this works:
    // We write the data to a single IndexedDB object store which contains both staged / committed attachments.
    // When staging, we write a row to a store of staged attachments with the attachment's key.
    // If the attachment is reject, both the staging record and the attachment bytes are deleted.
    // If the attachment is committed, this record is moved from the store of staging records to the store of committed records.
    // The motivation is that we only write data once, as we have to load it all into memory first.

    const db = await this.db;

    const bytes = attachment instanceof Uint8Array
      ? attachment
      : await streamToBytes(attachment);

    const hash = await Crypto.sha256base32(bytes);

    const indexKey = this.getIndexKey(formatName, hash);
    const blobKey = `${indexKey}___${randomId()}`;

    const transaction = db.transaction([
      ATTACHMENT_BYTES_STORE,
      ATTACHMENT_STAGING_STORE,
    ], "readwrite");

    const dataPut = transaction.objectStore(ATTACHMENT_BYTES_STORE).put(
      attachment,
      blobKey,
    );
    const stagingPut = transaction.objectStore(ATTACHMENT_STAGING_STORE).put({
      id: indexKey,
      blobKey,
    });

    const putDeferred = deferred();
    const stagingDeferred = deferred();

    dataPut.onsuccess = () => putDeferred.resolve();
    stagingPut.onsuccess = () => stagingDeferred.resolve();

    await putDeferred;
    await stagingDeferred;

    return {
      hash,
      size: bytes.byteLength,
      reject: async () => {
        const deleteTransaction = db.transaction([
          ATTACHMENT_BYTES_STORE,
          ATTACHMENT_STAGING_STORE,
        ], "readwrite");

        const dataDelete = deleteTransaction.objectStore(
          ATTACHMENT_BYTES_STORE,
        ).delete(blobKey);
        const stagingDelete = deleteTransaction.objectStore(
          ATTACHMENT_STAGING_STORE,
        ).delete(indexKey);

        const deleteDeferred = deferred<void>();
        const stagingDeleteDeferred = deferred<void>();

        dataDelete.onsuccess = () => {
          deleteDeferred.resolve();
        };
        stagingDelete.onsuccess = () => {
          stagingDeleteDeferred.resolve();
        };

        await Promise.all([deleteDeferred, stagingDeleteDeferred]);
      },
      commit: async () => {
        // delete staging index
        // write proper index

        const transaction = db.transaction([
          ATTACHMENT_INDEX_STORE,
          ATTACHMENT_STAGING_STORE,
        ], "readwrite");

        const deleteStaging = transaction.objectStore(
          ATTACHMENT_STAGING_STORE,
        ).delete(indexKey);

        const putRealIndex = transaction.objectStore(ATTACHMENT_INDEX_STORE)
          .put({ id: indexKey, blobKey });

        const deleteDeferred = deferred();
        const realIndexDeferred = deferred();

        deleteStaging.onsuccess = () => deleteDeferred.resolve();
        putRealIndex.onsuccess = () => realIndexDeferred.resolve();

        await Promise.all([deleteDeferred, realIndexDeferred]);
      },
    };
  }

  async wipe(): Promise<void> {
    const db = await this.db;
    const transaction = db.transaction([
      ATTACHMENT_BYTES_STORE,
      ATTACHMENT_INDEX_STORE,
      ATTACHMENT_STAGING_STORE,
    ], "readwrite");

    const wipeData = transaction.objectStore(ATTACHMENT_BYTES_STORE).clear();
    const wipeIndex = transaction.objectStore(ATTACHMENT_INDEX_STORE).clear();
    const wipeStaging = transaction.objectStore(ATTACHMENT_STAGING_STORE)
      .clear();

    const dataDeferred = deferred();
    const indexDeferred = deferred();
    const stagingDeferred = deferred();

    wipeData.onsuccess = () => dataDeferred.resolve();
    wipeIndex.onsuccess = () => indexDeferred.resolve();
    wipeStaging.onsuccess = () => stagingDeferred.resolve();

    await Promise.all([dataDeferred, indexDeferred, stagingDeferred]);
  }

  async clearStaging(): Promise<void> {
    // iterate through all the staging indexes and delete...
    const db = await this.db;

    const transaction = db.transaction([
      ATTACHMENT_BYTES_STORE,
      ATTACHMENT_STAGING_STORE,
    ]);

    const cursorReq = transaction.objectStore(ATTACHMENT_STAGING_STORE)
      .openCursor();

    const result = deferred<void>();

    cursorReq.onsuccess = () => {
      const res = cursorReq.result;

      if (!res) {
        // done
        result.resolve();
        return;
      }

      const blobKey = res.value.blobKey;

      const deleteBlob = transaction.objectStore(ATTACHMENT_BYTES_STORE).delete(
        blobKey,
      );

      res.delete();

      deleteBlob.onsuccess = () => {
        res.continue();
      };

      deleteBlob.onerror = () => {
        res.continue();
      };
    };

    return result;
  }

  async filter(
    attachments: Record<string, Set<string>>,
  ): Promise<{ format: string; hash: string }[]> {
    const db = await this.db;

    const transaction = db.transaction([
      ATTACHMENT_BYTES_STORE,
      ATTACHMENT_INDEX_STORE,
    ], "readwrite");

    const cursorReq = transaction.objectStore(ATTACHMENT_INDEX_STORE)
      .openCursor();

    const deleted: { format: string; hash: string }[] = [];
    const deletionOps: Promise<true | ValidationError>[] = [];
    const cursorDeferred = deferred<void>();

    cursorReq.onsuccess = () => {
      const res = cursorReq.result;

      if (!res) {
        cursorDeferred.resolve();

        return;
      }

      const [format, hash] = (res.value.id as string).split("___");

      if (attachments[format] && !attachments[format].has(hash)) {
        deleted.push({ format, hash });

        deletionOps.push(this.erase(format, hash));

        res.continue();
      } else {
        res.continue();
      }
    };

    await cursorDeferred;
    await Promise.all(deletionOps);

    return deleted;
  }
}
