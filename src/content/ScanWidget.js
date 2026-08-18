import { findScanTargets } from "./targets.js";

const DEFAULT_TRIGGER_INTERVAL_MS = 1000;
const UNKNOWN_STATUS_DISPLAY_LIMIT = 5;
const FAILURE_DISPLAY_LIMIT = 5;

/**
 * Run Renovate scan ボタン + モーダル + トースト。
 * すべての依存を引数で受ける（拡張 API・バンドラ専用 import を一切持たない）。
 *
 * @param {{
 *   currentOrg: {platform:string, org:string}|null,
 *   listOrgs: () => Promise<{platform:string, slug:string, label:string}[]>,
 *   listDisabledRepos: (input:{platform:string, org:string}) => Promise<{repos:{name:string}[], unknownStatuses:{name:string,raw:string}[]}>,
 *   listAliveRepoNames: (org:string) => Promise<{ok:true, repos:string[]}|{ok:false, error:string, code?:string}>,
 *   triggerScan: (target:{platform:string, org:string, repo:string}) => Promise<{ok:true, alreadyQueued?:boolean, skipped?:boolean}|{ok:false, reason:string}>,
 *   openSettings: () => void,
 *   sleep?: (ms:number) => Promise<void>,
 * }} deps
 * @returns {HTMLElement} シャドウルートに挿す container
 */
export default function createScanWidget(deps) {
	const sleep =
		deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

	const doc = document;

	const root = doc.createElement("div");
	root.className = "rr_root";
	root.innerHTML = `
    <button type="button" class="rr_launcher">Run Renovate scan</button>
    <div class="rr_modal" role="dialog" aria-modal="true" hidden>
      <div class="rr_backdrop"></div>
      <div class="rr_dialog">
        <button type="button" class="rr_close" aria-label="閉じる">×</button>
        <h2 class="rr_title">Run Renovate scan</h2>
        <p class="rr_notice" hidden></p>
        <button type="button" class="rr_settings" hidden>設定を開く</button>
        <section class="rr_orgs">
          <h3>1. 対象 org</h3>
          <div class="rr_org_list"></div>
          <button type="button" class="rr_find">対象を検索</button>
        </section>
        <section class="rr_targets" hidden>
          <h3>2. 対象リポジトリ (<span class="rr_target_count">0</span>)</h3>
          <button type="button" class="rr_select_all">全選択</button>
          <button type="button" class="rr_clear_all">全解除</button>
          <div class="rr_target_list"></div>
          <button type="button" class="rr_run">Run Renovate scan (0)</button>
        </section>
      </div>
    </div>
    <div class="rr_toast" hidden>
      <p class="rr_toast_text"></p>
      <button type="button" class="rr_toast_close" aria-label="閉じる">×</button>
    </div>
  `;

	const launcher = root.querySelector(".rr_launcher");
	const modal = root.querySelector(".rr_modal");
	const backdrop = root.querySelector(".rr_backdrop");
	const closeButton = root.querySelector(".rr_close");
	const notice = root.querySelector(".rr_notice");
	const settingsButton = root.querySelector(".rr_settings");
	const orgList = root.querySelector(".rr_org_list");
	const findButton = root.querySelector(".rr_find");
	const targetsSection = root.querySelector(".rr_targets");
	const targetCount = root.querySelector(".rr_target_count");
	const selectAllButton = root.querySelector(".rr_select_all");
	const clearAllButton = root.querySelector(".rr_clear_all");
	const targetList = root.querySelector(".rr_target_list");
	const runButton = root.querySelector(".rr_run");
	const toast = root.querySelector(".rr_toast");
	const toastText = root.querySelector(".rr_toast_text");
	const toastClose = root.querySelector(".rr_toast_close");

	let orgsLoaded = false;
	let running = false;

	function showNotice(message, { append = false } = {}) {
		notice.hidden = false;
		notice.textContent =
			append && notice.textContent
				? `${notice.textContent}\n${message}`
				: message;
	}

	function clearNotice() {
		notice.hidden = true;
		notice.textContent = "";
		settingsButton.hidden = true;
	}

	function showToast(message) {
		toast.hidden = false;
		toastText.textContent = message;
	}

	function openModal() {
		modal.hidden = false;
		if (!orgsLoaded) {
			orgsLoaded = true;
			loadOrgs();
		}
	}

	function closeModal() {
		modal.hidden = true;
	}

	function createCheckboxRow({ value, labelText, checked }) {
		const label = doc.createElement("label");
		const input = doc.createElement("input");
		input.type = "checkbox";
		input.value = value;
		input.checked = checked;
		label.appendChild(input);
		label.appendChild(doc.createTextNode(labelText));
		return { label, input };
	}

	async function loadOrgs() {
		orgList.textContent = "";
		try {
			const orgs = await deps.listOrgs();
			for (const org of orgs) {
				const value = `${org.platform}/${org.slug}`;
				const checked =
					deps.currentOrg !== null &&
					deps.currentOrg.platform === org.platform &&
					deps.currentOrg.org === org.slug;
				const { label } = createCheckboxRow({
					value,
					labelText: org.label,
					checked,
				});
				orgList.appendChild(label);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (deps.currentOrg) {
				const { label } = createCheckboxRow({
					value: `${deps.currentOrg.platform}/${deps.currentOrg.org}`,
					labelText: deps.currentOrg.org,
					checked: true,
				});
				orgList.appendChild(label);
				showNotice(
					`org 一覧を取得できませんでした（表示中の org のみ選択できます）: ${message}`,
				);
			} else {
				showNotice(`org 一覧を取得できませんでした: ${message}`);
				findButton.disabled = true;
			}
		}
	}

	function selectedOrgValues() {
		return [...orgList.querySelectorAll("input[type=checkbox]:checked")].map(
			(input) => input.value,
		);
	}

	function updateTargetSummary(count) {
		targetCount.textContent = String(count);
		runButton.textContent = `Run Renovate scan (${count})`;
		runButton.disabled = count === 0 || running;
	}

	async function findTargets() {
		findButton.disabled = true;
		settingsButton.hidden = true;
		try {
			clearNotice();
			targetList.textContent = "";
			targetsSection.hidden = true;

			const allTargets = [];
			const allUnknown = [];

			for (const value of selectedOrgValues()) {
				const [platform, org] = value.split("/");

				const aliveResult = await deps.listAliveRepoNames(org);
				if (!aliveResult.ok) {
					if (aliveResult.code === "no-token") {
						// GitHub チェックは必須条件なので token 無しでは 1 件も対象にしない。
						showNotice(aliveResult.error);
						settingsButton.hidden = false;
						return;
					}
					showNotice(`${org}: ${aliveResult.error}`, { append: true });
					continue;
				}

				const { repos, unknownStatuses } = await deps.listDisabledRepos({
					platform,
					org,
				});
				const { targets } = findScanTargets({
					platform,
					org,
					mendRepos: repos,
					aliveRepoNames: aliveResult.repos,
				});
				allTargets.push(...targets);
				allUnknown.push(...unknownStatuses);
			}

			if (allUnknown.length > 0) {
				const preview = allUnknown
					.slice(0, UNKNOWN_STATUS_DISPLAY_LIMIT)
					.map((entry) => `${entry.name}(${entry.raw})`)
					.join(", ");
				const suffix =
					allUnknown.length > UNKNOWN_STATUS_DISPLAY_LIMIT
						? ` 他 ${allUnknown.length - UNKNOWN_STATUS_DISPLAY_LIMIT} 件`
						: "";
				showNotice(
					`判別できない Renovate ステータス ${allUnknown.length} 件（対象外）: ${preview}${suffix}`,
					{ append: true },
				);
			}

			for (const target of allTargets) {
				const label = doc.createElement("label");
				const input = doc.createElement("input");
				input.type = "checkbox";
				input.checked = true;
				input.dataset.platform = target.platform;
				input.dataset.org = target.org;
				input.dataset.repo = target.repo;

				const name = doc.createElement("span");
				name.className = "rr_target_name";
				name.textContent = `${target.org}/${target.repo}`;

				const state = doc.createElement("span");
				state.className = "rr_target_state";

				label.appendChild(input);
				label.appendChild(name);
				label.appendChild(state);
				targetList.appendChild(label);
			}

			targetsSection.hidden = false;
			updateTargetSummary(allTargets.length);

			if (allTargets.length === 0) {
				showNotice("対象はありません", { append: true });
			}
		} finally {
			findButton.disabled = false;
		}
	}

	function setRunningState(next) {
		running = next;
		findButton.disabled = next;
		runButton.disabled = next || selectedTargetInputs().length === 0;
		for (const input of targetList.querySelectorAll("input[type=checkbox]")) {
			input.disabled = next;
		}
		for (const input of orgList.querySelectorAll("input[type=checkbox]")) {
			input.disabled = next;
		}
	}

	function selectedTargetInputs() {
		return [...targetList.querySelectorAll("input[type=checkbox]:checked")];
	}

	async function runScans() {
		const inputs = selectedTargetInputs();
		if (inputs.length === 0) return;

		setRunningState(true);
		let ok = 0;
		let queued = 0;
		let skipped = 0;
		let failed = 0;
		const failedRepos = [];

		try {
			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const row = input.closest("label");
				const state = row.querySelector(".rr_target_state");
				runButton.textContent = `Running… ${i + 1}/${inputs.length}`;

				if (i > 0) await sleep(DEFAULT_TRIGGER_INTERVAL_MS);

				try {
					const result = await deps.triggerScan({
						platform: input.dataset.platform,
						org: input.dataset.org,
						repo: input.dataset.repo,
					});
					if (result.ok) {
						if (result.skipped) {
							skipped++;
							state.textContent = "– skipped (no package files)";
						} else if (result.alreadyQueued) {
							queued++;
							state.textContent = "✓ already queued";
						} else {
							ok++;
							state.textContent = "✓ triggered";
						}
					} else {
						failed++;
						failedRepos.push(input.dataset.repo);
						state.textContent = `✗ ${result.reason}`;
					}
				} catch (error) {
					if (error?.name === "MendAuthError") {
						// セッション失効は以降の実行も失敗するため残りを中断する。
						showNotice(error.message);
						showToast(error.message);
						return;
					}
					failed++;
					failedRepos.push(input.dataset.repo);
					const message =
						error instanceof Error ? error.message : String(error);
					state.textContent = `✗ ${message}`;
				}
			}
		} finally {
			setRunningState(false);
			updateTargetSummary(selectedTargetInputs().length || inputs.length);
		}

		let message = `完了: 成功 ${ok} / スキップ ${skipped} / 既にキュー済み ${queued} / 失敗 ${failed}`;
		if (failedRepos.length > 0) {
			const preview = failedRepos.slice(0, FAILURE_DISPLAY_LIMIT).join(", ");
			const suffix =
				failedRepos.length > FAILURE_DISPLAY_LIMIT
					? ` 他 ${failedRepos.length - FAILURE_DISPLAY_LIMIT} 件`
					: "";
			message += `（失敗: ${preview}${suffix}）`;
		}
		showToast(message);
	}

	launcher.addEventListener("click", openModal);
	closeButton.addEventListener("click", closeModal);
	backdrop.addEventListener("click", closeModal);
	settingsButton.addEventListener("click", () => deps.openSettings());
	findButton.addEventListener("click", () => {
		findTargets().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			showNotice(message, { append: true });
		});
	});
	selectAllButton.addEventListener("click", () => {
		for (const input of targetList.querySelectorAll("input[type=checkbox]")) {
			input.checked = true;
		}
		updateTargetSummary(selectedTargetInputs().length);
	});
	clearAllButton.addEventListener("click", () => {
		for (const input of targetList.querySelectorAll("input[type=checkbox]")) {
			input.checked = false;
		}
		updateTargetSummary(0);
	});
	targetList.addEventListener("change", () => {
		if (!running) updateTargetSummary(selectedTargetInputs().length);
	});
	runButton.addEventListener("click", () => {
		runScans().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			showNotice(message, { append: true });
		});
	});
	toastClose.addEventListener("click", () => {
		toast.hidden = true;
	});
	doc.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !modal.hidden) closeModal();
	});

	return root;
}
