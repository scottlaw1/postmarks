/**
 * Module handles activitypub data management
 *
 * Server API calls the methods in here to query and update the SQLite database
 */

// Utilities we need
import * as path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import { account, domain, actorInfo } from "./util.js";

const dbFile = "./.data/activitypub.db";
let db;

setup();

function setup() {
  // activitypub not set up yet, skip until we have the data we need
  if (actorInfo.disabled) {
    return;
  }

  // Initialize the database
  const exists = fs.existsSync(dbFile);

  open({
    filename: dbFile,
    driver: sqlite3.Database,
  }).then(async (dBase) => {
    db = dBase;

    const actorName = `${account}@${domain}`;

    try {
      if (!exists) {
        await firstTimeSetup(actorName);
      }

      // re-run the profile portion of the actor setup every time in case the avatar, description, etc have changed
      const publicKey = await getPublicKey(account);
      const actorRecord = actorJson(account, domain, actorInfo, publicKey);
      await db.run(
        `UPDATE accounts SET name = ?, actor = ?`,
        actorName,
        JSON.stringify(actorRecord)
      );
    } catch (dbError) {
      console.error(dbError);
    }
  });
}

function actorJson(name, domain, actorInfo, pubkey) {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],

    id: `https://${domain}/u/${name}`,
    type: "Person",
    preferredUsername: `${name}`,
    name: actorInfo.displayName,
    summary: actorInfo.description,
    icon: {
      type: "Image",
      mediaType: `image/${path.extname(actorInfo.avatar).slice(1)}`,
      url: actorInfo.avatar,
    },
    inbox: `https://${domain}/api/inbox`,
    outbox: `https://${domain}/u/${name}/outbox`,
    followers: `https://${domain}/u/${name}/followers`,
    following: `https://${domain}/u/${name}/following`,

    publicKey: {
      id: `https://${domain}/u/${name}#main-key`,
      owner: `https://${domain}/u/${name}`,
      publicKeyPem: pubkey,
    },
  };
}

function webfingerJson(name, domain) {
  return {
    subject: `acct:${name}@${domain}`,

    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: `https://${domain}/u/${name}`,
      },
    ],
  };
}

async function firstTimeSetup(actorName) {
  const newDb = new sqlite3.Database(
    dbFile,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    (err) => {
      if (err) {
        console.log(`unable to open or create database: ${err}`);
        process.exit(1);
      }
    }
  );

  newDb.close();

  // now do it again, using the async/await library
  await open({
    filename: dbFile,
    driver: sqlite3.Database,
  }).then(async (dBase) => {
    db = dBase;
  });

  await db.run(
    "CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, privkey TEXT, pubkey TEXT, webfinger TEXT, actor TEXT, followers TEXT, following TEXT, messages TEXT, blocks TEXT)"
  );

  // if there is no `messages` table in the DB, create an empty table
  // TODO: index messages on bookmark_id
  await db.run(
    "CREATE TABLE IF NOT EXISTS messages (guid TEXT PRIMARY KEY, message TEXT, bookmark_id INTEGER)"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS permissions (bookmark_id INTEGER NOT NULL UNIQUE, allowed TEXT, blocked TEXT)"
  );

  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "rsa",
      {
        modulusLength: 4096,
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      },
      async (err, publicKey, privateKey) => {
        if (err) return reject(err);
        try {
          const actorRecord = actorJson(account, domain, actorInfo, publicKey);
          const webfingerRecord = webfingerJson(account, domain);

          await db.run(
            `INSERT OR REPLACE INTO accounts (name, actor, pubkey, privkey, webfinger) VALUES (?, ?, ?, ?, ?)`,
            actorName,
            JSON.stringify(actorRecord),
            publicKey,
            privateKey,
            JSON.stringify(webfingerRecord)
          );
          return resolve();
        } catch (e) {
          return reject(e);
        }
      }
    );
  });
}


export async function getFollowers() {
  const result = await db?.get("select followers from accounts limit 1");
  return result?.followers;
}

export async function setFollowers(followersJson) {
  return await db?.run("update accounts set followers=?", followersJson);
}

export async function getFollowing() {
  const result = await db?.get("select following from accounts limit 1");
  return result?.following;
}

export async function setFollowing(followingJson) {
  return await db?.run("update accounts set following=?", followingJson);
}

export async function getBlocks() {
  const result = await db?.get("select blocks from accounts limit 1");
  return result?.blocks;
}

export async function setBlocks(blocksJson) {
  return await db?.run("update accounts set blocks=?", blocksJson);
}

export async function getActor(name) {
  const result = await db?.get("select actor from accounts limit 1");
  return result?.actor;
}

export async function getWebfinger(name) {
  const result = await db?.get("select webfinger from accounts limit 1");
  return result?.webfinger;
}

export async function getPublicKey(name) {
  const result = await db?.get("select pubkey from accounts limit 1");
  return result?.pubkey;
}

export async function getPrivateKey(name) {
  const result = await db?.get("select privkey from accounts limit 1");
  return result?.privkey;
}

export async function getGuidForBookmarkId(id) {
  return (await db?.get("select guid from messages where bookmark_id = ?", id))
    ?.guid;
}

export async function getBookmarkIdFromMessageGuid(guid) {
  return (
    await db?.get("select bookmark_id from messages where guid = ?", guid)
  )?.bookmark_id;
}

export async function getMessage(guid) {
  return await db?.get("select message from messages where guid = ?", guid);
}

export async function findMessageGuid(bookmarkId) {
  return (
    await db?.get("select guid from messages where bookmark_id = ?", bookmarkId)
  )?.guid;
}

export async function deleteMessage(guid) {
  await db?.get("delete from messages where guid = ?", guid);
  return;
}

export async function getGlobalPermissions() {
  return await db?.get("select * from permissions where bookmark_id = 0");
}

export async function setGlobalPermissions(allowed, blocked) {
  return await setPermissionsForBookmark(0, allowed, blocked);
}

export async function setPermissionsForBookmark(id, allowed, blocked) {
  return await db?.run(
    "insert or replace into permissions(bookmark_id, allowed, blocked) values (?, ?, ?)",
    id,
    allowed,
    blocked
  );
}

export async function getPermissionsForBookmark(id) {
  return await db?.get("select * from permissions where bookmark_id = ?", id);
}

export async function insertMessage(guid, bookmarkId, json) {
  return await db?.run(
    "insert or replace into messages(guid, bookmark_id, message) values(?, ?, ?)",
    guid,
    bookmarkId,
    json
  );
}

export async function findMessage(object) {
  return await db?.all(
    "select * from messages where message like ?",
    `%${object}%`
  );
}
