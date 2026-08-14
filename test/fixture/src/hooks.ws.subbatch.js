// Fixture handler for the subscribeBatch failure variants.
//
// Exports ONLY `subscribeBatch`: with it present the runtime never consults a
// per-topic `subscribe` hook, so this build isolates exactly the batch-hook
// paths ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK and ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT
// document. Each failure mode is selected by a topic NAME inside the batch, so
// a real client reaches it with an ordinary subscribe-batch frame:
//
// - any topic `batch-throw:*` - the hook itself throws. One faulting topic
//   must take the whole batch down as INTERNAL_ERROR.
// - any topic `poison-read:*` - the hook returns a result whose property
//   read throws (an enumerable getter), which is the post-hook failure the
//   batch-result entry documents.
// - any topic `array-shape:*` - the hook returns an ARRAY of denial reasons,
//   the shape the batch-result entry's guidance used to prescribe. Arrays are
//   read as index-keyed records, so these denials name topics '0' and '1' and
//   the real topics land unopposed - the case that keeps the corrected
//   guidance honest.
// - `deny:*` - denied via the documented record shape (the control that
//   proves this hook's decisions normally land per topic).
// - anything else - allow.

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

export function subscribeBatch(_ws, topics) {
	if (topics.some((t) => t.startsWith('batch-throw:'))) {
		throw new Error('subscribeBatch probe fault');
	}
	const poisoned = topics.find((t) => t.startsWith('poison-read:'));
	if (poisoned !== undefined) {
		const result = {};
		Object.defineProperty(result, poisoned, {
			enumerable: true,
			get() { throw new Error('subscribeBatch result read fault'); }
		});
		return result;
	}
	if (topics.some((t) => t.startsWith('array-shape:'))) {
		return topics.map(() => 'FORBIDDEN');
	}
	/** @type {Record<string, false>} */
	const denials = {};
	for (const topic of topics) {
		if (topic.startsWith('deny:')) denials[topic] = false;
	}
	return denials;
}

// Membership as the SERVER sees it. A denial frame alone would still be
// satisfied by a runtime that answered the client and subscribed it anyway.
export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'count') {
		platform.send(ws, 'probe', 'count', { topic: msg.topic, count: platform.subscribers(msg.topic) });
	}
}
