// Localizing waiting-room renderer for the build-real pipeline suite: a
// module PATH configured through waitingRoom.renderer, bundled by the adapter
// build into the isolated renderer entry the runtime bridge imports.
export function renderWaitingRoom({ queueDepth, request }) {
	const preferred = (request.headers.get('accept-language') || '').toLowerCase();
	const french = preferred.startsWith('fr');
	const lang = french ? 'fr' : 'en';
	const title = french ? "File d'attente" : 'Waiting room';
	const status = french
		? 'Vous êtes dans la file. Position mise à jour automatiquement.'
		: 'You are in the queue. Your position updates automatically.';
	const retry = french ? 'Réessayer maintenant' : 'Retry now';
	const depth = Number.isFinite(queueDepth) ? String(queueDepth) : '';
	const body = '<!doctype html>\n' +
		`<html lang="${lang}" dir="ltr">\n` +
		'<head><meta charset="utf-8"><title>' + title + '</title></head>\n' +
		'<body>\n' +
		'<main>\n' +
		'<h1>' + title + '</h1>\n' +
		'<p role="status">' + status + (depth ? ' (' + depth + ')' : '') + '</p>\n' +
		'<a href="/">' + retry + '</a>\n' +
		'</main>\n' +
		'</body>\n' +
		'</html>\n';
	return { body, lang, dir: 'ltr' };
}
