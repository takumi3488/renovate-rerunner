import { listAliveRepoNames } from "./github/client.js";
import { ext } from "./shared/runtime.js";

function openSidebar() {
	if (ext.sidebarAction?.open) {
		// Firefox 経路
		ext.sidebarAction.open();
		return;
	}

	if (!ext.sidePanel) return;
	if (!ext.sidePanel.open) return;

	ext.tabs.query({ active: true, currentWindow: true }, (tabs) => {
		const activeTabId = tabs?.[0]?.id;
		if (!activeTabId) return;

		try {
			ext.sidePanel.open({ tabId: activeTabId });
		} catch (error) {
			console.error(error);
		}
	});
}

async function resolveAliveRepos(org) {
	const { githubToken, excludeForks = true } = await ext.storage.local.get([
		"githubToken",
		"excludeForks",
	]);

	if (!githubToken) {
		return {
			ok: false,
			code: "no-token",
			error: "GitHub token が未設定です。拡張の設定で保存してください。",
		};
	}

	try {
		const repos = await listAliveRepoNames({
			org,
			token: githubToken,
			excludeForks,
		});
		return { ok: true, repos };
	} catch (error) {
		// トークン本体は絶対にレスポンスに含めない。
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

if (ext.sidePanel) {
	// setPanelBehavior only affects FUTURE action clicks, registering it
	// inside onClicked would swallow the first toolbar click.
	ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

const browserAction = ext.browserAction ?? ext.action;
if (ext.sidebarAction && browserAction) {
	browserAction.onClicked.addListener(() => {
		ext.sidebarAction.open();
	});
}

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "openSidebar") {
		openSidebar();
		return;
	}
	if (message?.type === "githubAliveRepos") {
		resolveAliveRepos(message.org).then(sendResponse);
		// Chrome MV3 はリスナーの戻り値 Promise を解釈しないので
		// sendResponse + return true で非同期応答にする。
		return true;
	}
});
