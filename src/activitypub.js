import fetch from "node-fetch";
import crypto from "crypto";

import { signedGetJSON, signedPostJSON } from './signature.js';
import { actorInfo, actorMatchesUsername, replaceEmptyText } from './util.js';

function getGuidFromPermalink(urlString) {
  return urlString.match(/(?:\/m\/)([a-zA-Z0-9+/]+)/)[1];
}

export async function signAndSend(
  message,
  name,
  domain,
  db,
  targetDomain,
  inbox
) {
  // get the private key
  let inboxFragment = inbox.replace("https://" + targetDomain, "");
  const privkey = await db.getPrivateKey(`${name}@${domain}`);

  if (privkey === undefined) {
    console.log(`No private key found for ${name}.`);
  } else {
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(message))
      .digest("base64");
    const signer = crypto.createSign("sha256");
    let d = new Date();
    let stringToSign = `(request-target): post ${inboxFragment}\nhost: ${targetDomain}\ndate: ${d.toUTCString()}\ndigest: SHA-256=${digest}`;
    signer.update(stringToSign);
    signer.end();
    const signature = signer.sign(privkey);
    const signature_b64 = signature.toString("base64");

    const algorithm = "rsa-sha256";
    let header = `keyId="https://${domain}/u/${name}",algorithm="${algorithm}",headers="(request-target) host date digest",signature="${signature_b64}"`;

    try {
      const response = await fetch(inbox, {
        headers: {
          Host: targetDomain,
          Date: d.toUTCString(),
          Digest: `SHA-256=${digest}`,
          Signature: header,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        method: "POST",
        body: JSON.stringify(message),
      });

      const data = await response.text();

      console.log(`Sent message to an inbox at ${targetDomain}!`);
      console.log("Response Status Code:", response.status);
      console.log("Response body:", data);
    } catch (error) {
      console.log("Error:", error.message);
      console.log("Stacktrace: ", error.stack);
    }
  }
}

export function createNoteObject(bookmark, account, domain) {
  const guidNote = crypto.randomBytes(16).toString("hex");
  const d = new Date();

  const linkedTags = bookmark.tags
    ?.split(" ")
    .map((tag) => {
      const tagName = tag.slice(1);
      return `<a href=\"https://${domain}/tagged/${tagName}\" class=\"mention hashtag\" rel=\"tag\">${tag}</a>`;
    })
    .join(" ");

  const noteMessage = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `https://${domain}/m/${guidNote}`,
    type: "Note",
    published: d.toISOString(),
    attributedTo: `https://${domain}/u/${account}`,
    content: `<strong><a href="${bookmark.url}" rel="nofollow noopener noreferrer" target="_blank">${replaceEmptyText(
      bookmark.title,
      bookmark.url,
    )}</a></strong><br/>${bookmark.description?.trim().replace('\n', '<br/>') || ''}`,
    to: [`https://${domain}/u/${account}/followers/`, 'https://www.w3.org/ns/activitystreams#Public'],
    tag: [],
  };

  bookmark.tags?.split(" ").forEach((tag) => {
    const tagName = tag.slice(1);
    noteMessage.tag.push({
      type: "Hashtag",
      href: `https://${domain}/tagged/${tagName}`,
      name: tag,
    });
  });

  return noteMessage;
}

async function createUpdateMessage(bookmark, account, domain, db) {
  const guid = await db.getGuidForBookmarkId(bookmark.id);

  // if the bookmark was created but not published to activitypub
  // we might need to just make our own note object to send along
  let note;
  if (guid === undefined) {
    note = createNoteObject(bookmark, account, domain);
    createMessage(note, bookmark.id, account, domain, db);
  } else {
    note = `https://${domain}/m/${guid}`;
  }

  const updateMessage = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    summary: `${account} updated the bookmark`,
    type: "Create", // this should be 'Update' but Mastodon does weird things with Updates
    actor: `https://${domain}/u/${account}`,
    object: note,
  };

  return updateMessage;
}

function createMessage(noteObject, bookmarkId, account, domain, db) {
  const guidCreate = crypto.randomBytes(16).toString("hex");

  const createMessage = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `https://${domain}/m/${guidCreate}`,
    type: "Create",
    actor: `https://${domain}/u/${account}`,
    to: [
      `https://${domain}/u/${account}/followers/`,
      "https://www.w3.org/ns/activitystreams#Public",
    ],
    object: noteObject,
  };

  db.insertMessage(
    getGuidFromPermalink(noteObject.id),
    bookmarkId,
    JSON.stringify(noteObject)
  );

  return createMessage;
}

async function createDeleteMessage(bookmark, account, domain, db) {
  const guid = await db.findMessageGuid(bookmark.id);
  await db.deleteMessage(guid);

  const deleteMessage = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `https://${domain}/m/${guid}`,
    type: "Delete",
    actor: `https://${domain}/u/${account}`,
    to: [
      `https://${domain}/u/${account}/followers/`,
      "https://www.w3.org/ns/activitystreams#Public",
    ],
    object: {
      type: "Tombstone",
      id: `https://${domain}/m/${guid}`,
    },
  };

  return deleteMessage;
}

export async function createFollowMessage(account, domain, target, db) {
  const guid = crypto.randomBytes(16).toString("hex");
  const followMessage = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: guid,
    type: "Follow",
    actor: `https://${domain}/u/${account}`,
    object: target,
  };

  db.insertMessage(guid, null, JSON.stringify(followMessage));

  return followMessage;
}

export async function createUnfollowMessage(account, domain, target, db) {
  const undoGuid = crypto.randomBytes(16).toString("hex");

  const messageRows = await db.findMessage(target);

  console.log("result", messageRows)

  const followMessages = messageRows?.filter((row) => {
    const message = JSON.parse(row.message || "{}");
    return (
      message.type === "Follow" && message.object === target
    );
  });

  if (followMessages?.length > 0) {
    const undoMessage = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Undo",
      id: undoGuid,
      actor: `${domain}/u/${account}`,
      object: followMessages.slice(-1).message,
    };
    return undoMessage;
  } else {
    console.log(
      "tried to find a Follow record in order to unfollow, but failed"
    );
    return null;
  }
}

export async function getInboxFromActorProfile(profileUrl) {
  const response = await fetch(`${profileUrl}.json`);
  const data = await response.json();

  if (data?.inbox) {
    return data.inbox
  } else {
    throw new Error(`Couldn't find inbox at supplied profile url ${profileUrl}`);
  }
}

// actorUsername format is @username@domain
export async function lookupActorInfo(actorUsername) {
  const parsedDomain = actorUsername.split("@").slice(-1);
  const parsedUsername = actorUsername.split("@").slice(-2, -1);
  try {
    const response = await fetch(
      `https://${parsedDomain}/.well-known/webfinger/?resource=acct:${parsedUsername}@${parsedDomain}`
    );
    const data = await response.json();
    const selfLink = data.links.find((o) => o.rel === "self");
    if (!selfLink || !selfLink.href) {
      throw new Error();
    }

    return selfLink.href;
  } catch (e) {
    console.log("couldn't look up canonical actor info");
    return null;
  }
}

export async function broadcastMessage(bookmark, action, db, account, domain) {
  if (actorInfo.disabled) {
    return; // no fediverse setup, so no purpose trying to send messages
  }

  const result = await db.getFollowers();
  const followers = JSON.parse(result);

  if (followers === null) {
    console.log(`No followers for account ${account}@${domain}`);
  } else {
    const bookmarkPermissions = await db.getPermissionsForBookmark(bookmark.id);
    const globalPermissions = await db.getGlobalPermissions();
    const blocklist =
      bookmarkPermissions?.blocked
        ?.split("\n")
        ?.concat(globalPermissions?.blocked?.split("\n"))
        .filter((x) => !x?.match(/^@([^@]+)@(.+)$/)) || [];

    //now let's try to remove the blocked users
    followers.filter((actor) => {
      const matches = blocklist.forEach((username) => {
        actorMatchesUsername(actor, username);
      });

      return !matches?.some((x) => x);
    });

    const noteObject = createNoteObject(await bookmark, account, domain);
    let message;
    switch (action) {
      case "create":
        message = createMessage(noteObject, bookmark.id, account, domain, db);
        break;
      case "update":
        message = await createUpdateMessage(bookmark, account, domain, db);
        break;
      case "delete":
        message = await createDeleteMessage(bookmark, account, domain, db);
        break;
      default:
        console.log("unsupported action!");
        return;
    }

    console.log(
      `sending this message to all followers: ${JSON.stringify(message)}`
    );

    for (let follower of followers) {
      let inbox = follower + "/inbox";
      let myURL = new URL(follower);
      let targetDomain = myURL.host;
      signAndSend(message, account, domain, db, targetDomain, inbox);
    }
  }
}

export function synthesizeActivity(note) {
  return {
    // Fake activity URI adds a "a-" prefix to the Note/message guid
    id: note.id.replace('/m/', '/m/a-'),
    type: 'Create',
    published: note.published,
    actor: note.attributedTo,
    object: note,
  };
}
