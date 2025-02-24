'use strict';

const _ = require('lodash');

const db = require('../database');
const topics = require('.');
const categories = require('../categories');
const user = require('../user');
const plugins = require('../plugins');
const privileges = require('../privileges');


module.exports = function (Topics) {
	const topicTools = {};
	Topics.tools = topicTools;

	topicTools.delete = async function (tid, uid) {
		return await toggleDelete(tid, uid, true);
	};

	topicTools.restore = async function (tid, uid) {
		return await toggleDelete(tid, uid, false);
	};

	async function toggleDelete(tid, uid, isDelete) {
		const topicData = await Topics.getTopicData(tid);
		if (!topicData) {
			throw new Error('[[error:no-topic]]');
		}
		// Scheduled topics can only be purged
		if (topicData.scheduled) {
			throw new Error('[[error:invalid-data]]');
		}
		const canDelete = await privileges.topics.canDelete(tid, uid);

		const hook = isDelete ? 'delete' : 'restore';
		const data = await plugins.hooks.fire(`filter:topic.${hook}`, { topicData: topicData, uid: uid, isDelete: isDelete, canDelete: canDelete, canRestore: canDelete });

		if ((!data.canDelete && data.isDelete) || (!data.canRestore && !data.isDelete)) {
			throw new Error('[[error:no-privileges]]');
		}
		if (data.topicData.deleted && data.isDelete) {
			throw new Error('[[error:topic-already-deleted]]');
		} else if (!data.topicData.deleted && !data.isDelete) {
			throw new Error('[[error:topic-already-restored]]');
		}
		if (data.isDelete) {
			await Topics.delete(data.topicData.tid, data.uid);
		} else {
			await Topics.restore(data.topicData.tid);
		}
		const events = await Topics.events.log(tid, { type: isDelete ? 'delete' : 'restore', uid });

		data.topicData.deleted = data.isDelete ? 1 : 0;

		if (data.isDelete) {
			plugins.hooks.fire('action:topic.delete', { topic: data.topicData, uid: data.uid });
		} else {
			plugins.hooks.fire('action:topic.restore', { topic: data.topicData, uid: data.uid });
		}
		const userData = await user.getUserFields(data.uid, ['username', 'userslug']);
		return {
			tid: data.topicData.tid,
			cid: data.topicData.cid,
			isDelete: data.isDelete,
			uid: data.uid,
			user: userData,
			events,
		};
	}

	topicTools.purge = async function (tid, uid) {
		const topicData = await Topics.getTopicData(tid);
		if (!topicData) {
			throw new Error('[[error:no-topic]]');
		}
		const canPurge = await privileges.topics.canPurge(tid, uid);
		if (!canPurge) {
			throw new Error('[[error:no-privileges]]');
		}

		await Topics.purgePostsAndTopic(tid, uid);
		return { tid: tid, cid: topicData.cid, uid: uid };
	};

	topicTools.lock = async function (tid, uid) {
		return await toggleLock(tid, uid, true);
	};

	topicTools.unlock = async function (tid, uid) {
		return await toggleLock(tid, uid, false);
	};

	async function toggleLock(tid, uid, lock) {
		const topicData = await Topics.getTopicFields(tid, ['tid', 'uid', 'cid']);
		if (!topicData || !topicData.cid) {
			throw new Error('[[error:no-topic]]');
		}
		const isAdminOrMod = await privileges.categories.isAdminOrMod(topicData.cid, uid);
		if (!isAdminOrMod) {
			throw new Error('[[error:no-privileges]]');
		}
		await Topics.setTopicField(tid, 'locked', lock ? 1 : 0);
		topicData.events = await Topics.events.log(tid, { type: lock ? 'lock' : 'unlock', uid });
		topicData.isLocked = lock; // deprecate in v2.0
		topicData.locked = lock;

		plugins.hooks.fire('action:topic.lock', { topic: _.clone(topicData), uid: uid });
		return topicData;
	}

	topicTools.pin = async function (tid, uid) {
		return await togglePin(tid, uid, true);
	};

	topicTools.unpin = async function (tid, uid) {
		return await togglePin(tid, uid, false);
	};

	topicTools.setPinExpiry = async (tid, expiry, uid) => {
		if (isNaN(parseInt(expiry, 10)) || expiry <= Date.now()) {
			throw new Error('[[error:invalid-data]]');
		}

		const topicData = await Topics.getTopicFields(tid, ['tid', 'uid', 'cid']);
		const isAdminOrMod = await privileges.categories.isAdminOrMod(topicData.cid, uid);
		if (!isAdminOrMod) {
			throw new Error('[[error:no-privileges]]');
		}

		await Topics.setTopicField(tid, 'pinExpiry', expiry);
		plugins.hooks.fire('action:topic.setPinExpiry', { topic: _.clone(topicData), uid: uid });
	};

	topicTools.checkPinExpiry = async (tids) => {
		const expiry = (await topics.getTopicsFields(tids, ['pinExpiry'])).map(obj => obj.pinExpiry);
		const now = Date.now();

		tids = await Promise.all(tids.map(async (tid, idx) => {
			if (expiry[idx] && parseInt(expiry[idx], 10) <= now) {
				await togglePin(tid, 'system', false);
				return null;
			}

			return tid;
		}));

		return tids.filter(Boolean);
	};

	async function togglePin(tid, uid, pin) {
		const topicData = await Topics.getTopicData(tid);
		if (!topicData) {
			throw new Error('[[error:no-topic]]');
		}

		if (topicData.scheduled) {
			throw new Error('[[error:cant-pin-scheduled]]');
		}

		if (uid !== 'system' && !await privileges.topics.isAdminOrMod(tid, uid)) {
			throw new Error('[[error:no-privileges]]');
		}

		const promises = [
			Topics.setTopicField(tid, 'pinned', pin ? 1 : 0),
			Topics.events.log(tid, { type: pin ? 'pin' : 'unpin', uid }),
		];
		if (pin) {
			promises.push(db.sortedSetAdd(`cid:${topicData.cid}:tids:pinned`, Date.now(), tid));
			promises.push(db.sortedSetsRemove([
				`cid:${topicData.cid}:tids`,
				`cid:${topicData.cid}:tids:posts`,
				`cid:${topicData.cid}:tids:votes`,
			], tid));
		} else {
			promises.push(db.sortedSetRemove(`cid:${topicData.cid}:tids:pinned`, tid));
			promises.push(Topics.deleteTopicField(tid, 'pinExpiry'));
			promises.push(db.sortedSetAddBulk([
				[`cid:${topicData.cid}:tids`, topicData.lastposttime, tid],
				[`cid:${topicData.cid}:tids:posts`, topicData.postcount, tid],
				[`cid:${topicData.cid}:tids:votes`, parseInt(topicData.votes, 10) || 0, tid],
			]));
			topicData.pinExpiry = undefined;
			topicData.pinExpiryISO = undefined;
		}

		const results = await Promise.all(promises);

		topicData.isPinned = pin; // deprecate in v2.0
		topicData.pinned = pin;
		topicData.events = results[1];

		plugins.hooks.fire('action:topic.pin', { topic: _.clone(topicData), uid });

		return topicData;
	}

	topicTools.orderPinnedTopics = async function (uid, data) {
		const tids = data.map(topic => topic && topic.tid);
		const topicData = await Topics.getTopicsFields(tids, ['cid']);

		const uniqueCids = _.uniq(topicData.map(topicData => topicData && topicData.cid));
		if (uniqueCids.length > 1 || !uniqueCids.length || !uniqueCids[0]) {
			throw new Error('[[error:invalid-data]]');
		}

		const cid = uniqueCids[0];

		const isAdminOrMod = await privileges.categories.isAdminOrMod(cid, uid);
		if (!isAdminOrMod) {
			throw new Error('[[error:no-privileges]]');
		}

		const isPinned = await db.isSortedSetMembers(`cid:${cid}:tids:pinned`, tids);
		data = data.filter((topicData, index) => isPinned[index]);
		const bulk = data.map(topicData => [`cid:${cid}:tids:pinned`, topicData.order, topicData.tid]);
		await db.sortedSetAddBulk(bulk);
	};

	topicTools.move = async function (tid, data) {
		const cid = parseInt(data.cid, 10);
		const topicData = await Topics.getTopicData(tid);
		if (!topicData) {
			throw new Error('[[error:no-topic]]');
		}
		if (cid === topicData.cid) {
			throw new Error('[[error:cant-move-topic-to-same-category]]');
		}
		const tags = await Topics.getTopicTags(tid);
		await db.sortedSetsRemove([
			`cid:${topicData.cid}:tids`,
			`cid:${topicData.cid}:tids:pinned`,
			`cid:${topicData.cid}:tids:posts`,
			`cid:${topicData.cid}:tids:votes`,
			`cid:${topicData.cid}:tids:lastposttime`,
			`cid:${topicData.cid}:recent_tids`,
			`cid:${topicData.cid}:uid:${topicData.uid}:tids`,
			...tags.map(tag => `cid:${topicData.cid}:tag:${tag}:topics`),
		], tid);

		topicData.postcount = topicData.postcount || 0;
		const votes = topicData.upvotes - topicData.downvotes;

		const bulk = [
			[`cid:${cid}:tids:lastposttime`, topicData.lastposttime, tid],
			[`cid:${cid}:uid:${topicData.uid}:tids`, topicData.timestamp, tid],
			...tags.map(tag => [`cid:${cid}:tag:${tag}:topics`, topicData.timestamp, tid]),
		];
		if (topicData.pinned) {
			bulk.push([`cid:${cid}:tids:pinned`, Date.now(), tid]);
		} else {
			bulk.push([`cid:${cid}:tids`, topicData.lastposttime, tid]);
			bulk.push([`cid:${cid}:tids:posts`, topicData.postcount, tid]);
			bulk.push([`cid:${cid}:tids:votes`, votes, tid]);
		}
		await db.sortedSetAddBulk(bulk);

		const oldCid = topicData.cid;
		await categories.moveRecentReplies(tid, oldCid, cid);

		await Promise.all([
			categories.incrementCategoryFieldBy(oldCid, 'topic_count', -1),
			categories.incrementCategoryFieldBy(cid, 'topic_count', 1),
			categories.updateRecentTidForCid(cid),
			categories.updateRecentTidForCid(oldCid),
			Topics.setTopicFields(tid, {
				cid: cid,
				oldCid: oldCid,
			}),
			Topics.updateCategoryTagsCount([oldCid, cid], tags),
			Topics.events.log(tid, { type: 'move', uid: data.uid, fromCid: oldCid }),
		]);
		const hookData = _.clone(data);
		hookData.fromCid = oldCid;
		hookData.toCid = cid;
		hookData.tid = tid;

		plugins.hooks.fire('action:topic.move', hookData);
	};
};
