import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function validateReleaseEnvironment(environment, policies) {
	const reviewers = environment.protection_rules?.find(rule => rule.type === 'required_reviewers');
	if (environment.name !== 'npm-release' || !Array.isArray(reviewers?.reviewers) || reviewers.reviewers.length === 0) {
		throw new Error('npm-release must exist and require human review');
	}
	if (environment.deployment_branch_policy?.custom_branch_policies !== true ||
		environment.deployment_branch_policy?.protected_branches !== false || policies.total_count !== 1 ||
		policies.branch_policies?.length !== 1 || policies.branch_policies[0].name !== 'svelte-adapter-uws@*' ||
		policies.branch_policies[0].type !== 'tag') {
		throw new Error('npm-release must allow only the package version tag pattern');
	}
}

async function main() {
	if (!process.env.GH_TOKEN) throw new Error('read-only GitHub API credential is required');
	const get = async path => {
		const response = await fetch('https://api.github.com/repos/lanteanio/svelte-adapter-uws/environments/npm-release' + path, {
			headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN, 'X-GitHub-Api-Version': '2022-11-28' }
		});
		if (!response.ok) throw new Error('release environment could not be verified: HTTP ' + response.status);
		return response.json();
	};
	validateReleaseEnvironment(await get(''), await get('/deployment-branch-policies'));
	console.log('release environment requires review and permits only version tags');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
