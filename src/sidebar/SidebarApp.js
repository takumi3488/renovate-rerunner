import { ext } from "../shared/runtime.js";
import "./styles.css";

function SidebarApp() {
	const root = document.getElementById("root");
	if (!root) return;

	root.innerHTML = `
    <form class="settings_form">
      <label for="github_token">GitHub personal access token</label>
      <input id="github_token" type="password" autocomplete="off" />
      <p class="settings_hint">classic は repo、fine-grained は対象 org への Metadata: Read-only</p>
      <label for="exclude_forks">
        <input id="exclude_forks" type="checkbox" />
        fork を対象から除外する
      </label>
      <button type="submit" class="settings_save">保存</button>
      <button type="button" class="settings_clear">トークンを削除</button>
      <p class="settings_status" aria-live="polite"></p>
    </form>
  `;

	const form = root.querySelector(".settings_form");
	const tokenInput = root.querySelector("#github_token");
	const excludeForksInput = root.querySelector("#exclude_forks");
	const clearButton = root.querySelector(".settings_clear");
	const status = root.querySelector(".settings_status");

	async function load() {
		const { githubToken, excludeForks = true } = await ext.storage.local.get([
			"githubToken",
			"excludeForks",
		]);
		excludeForksInput.checked = excludeForks;
		// トークンは値を復元せず placeholder で保存状態だけ示す。
		tokenInput.placeholder = githubToken
			? "保存済み（変更する場合のみ入力）"
			: "未設定";
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const updates = { excludeForks: excludeForksInput.checked };
		// 入力が空ならトークンは書き換えない。
		if (tokenInput.value) {
			updates.githubToken = tokenInput.value;
		}
		await ext.storage.local.set(updates);
		tokenInput.value = "";
		tokenInput.placeholder = updates.githubToken
			? "保存済み（変更する場合のみ入力）"
			: tokenInput.placeholder;
		status.textContent = "保存しました";
	});

	clearButton.addEventListener("click", async () => {
		await ext.storage.local.remove("githubToken");
		tokenInput.value = "";
		tokenInput.placeholder = "未設定";
		status.textContent = "トークンを削除しました";
	});

	load();
}

SidebarApp();
