/**
 * Discord Webhook への通知。
 *
 * developer.mend.io の Cookie が失効すると、ブラウザ拡張が cookiejar-server に保存する
 * 仕組み上、人間がブラウザでログインし直すしかない。そのログインを促す通知（および
 * 実行時エラーの通知）を Discord に送るのがこのモジュールの役割。
 *
 * CronJob として動くため、通知の送信自体が失敗してもジョブ全体の成否には影響させない
 * （通知はあくまで補助であり、本処理の結果を通知の成否で汚さない）。
 */

import type { Logger } from "../logger";

export interface Notifier {
	/** 通知を送る。失敗しても例外を投げない。送信を試みたかどうかを返す。 */
	notify(notification: Notification): Promise<boolean>;
}

export interface Notification {
	/** 通知の種類。件名の組み立てと色分けに使う。 */
	readonly kind: "login-required" | "error";
	readonly title: string;
	readonly message: string;
	/** 人間が次に取るべき行動。 */
	readonly hint?: string;
	/** 補足情報。key: value の形で本文に並べる。**秘匿値を入れないこと。** */
	readonly fields?: Readonly<Record<string, string>>;
}

export interface CreateNotifierOptions {
	/** 未設定なら通知を送らない no-op の Notifier になる。 */
	readonly webhookUrl?: string;
	readonly logger: Logger;
	/** テスト用。省略時は fetch。 */
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
}

interface DiscordEmbedField {
	readonly name: string;
	readonly value: string;
	readonly inline: boolean;
}

interface DiscordEmbed {
	readonly title: string;
	readonly description: string;
	readonly color: number;
	readonly fields: readonly DiscordEmbedField[];
}

/** Discord Embed オブジェクトの文字数・件数制限（超過するとリクエスト全体が 400 になる）。 */
const TITLE_MAX_LENGTH = 256;
const DESCRIPTION_MAX_LENGTH = 4096;
const FIELD_NAME_MAX_LENGTH = 256;
const FIELD_VALUE_MAX_LENGTH = 1024;
const MAX_FIELDS = 25;

const DEFAULT_TIMEOUT_MS = 10_000;

const COLORS: Readonly<Record<Notification["kind"], number>> = {
	"login-required": 16753920,
	error: 15158332,
};

/**
 * 文字列を指定の最大長に切り詰める。超過分は末尾を省略記号 1 文字に置き換える。
 *
 * Discord の embed は各フィールドに文字数制限があり、超えるとリクエスト全体が
 * 400 エラーになって通知そのものが失われてしまう。呼び出し元の値の長さを事前に
 * 保証できないため、送信直前にここで必ず切り詰める。
 */
export function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

/**
 * embed の fields 配列を組み立てる。
 *
 * hint は「対処」という名前で先頭に置く（非 inline。他の fields と並べて折り返されると
 * 読みにくいため）。fields は Record で渡ってくる補足情報を inline で並べる。
 * 件数は Discord の上限（25 件）に切り詰める。
 */
function buildFields(notification: Notification): DiscordEmbedField[] {
	const fields: DiscordEmbedField[] = [];

	if (notification.hint) {
		fields.push({
			name: "対処",
			value: truncateText(notification.hint, FIELD_VALUE_MAX_LENGTH),
			inline: false,
		});
	}

	if (notification.fields) {
		for (const [name, value] of Object.entries(notification.fields)) {
			fields.push({
				name: truncateText(name, FIELD_NAME_MAX_LENGTH),
				value: truncateText(value, FIELD_VALUE_MAX_LENGTH),
				inline: true,
			});
		}
	}

	return fields.slice(0, MAX_FIELDS);
}

function buildEmbed(notification: Notification): DiscordEmbed {
	return {
		title: truncateText(notification.title, TITLE_MAX_LENGTH),
		description: truncateText(notification.message, DESCRIPTION_MAX_LENGTH),
		color: COLORS[notification.kind],
		fields: buildFields(notification),
	};
}

/** 常に何もせず false を返す Notifier。webhookUrl 未設定時の既定動作。 */
function createNoopNotifier(logger: Logger): Notifier {
	return {
		async notify(): Promise<boolean> {
			logger.info(
				"Discord 通知は未設定のためスキップした（DISCORD_WEBHOOK_URL 未設定）",
			);
			return false;
		},
	};
}

export function createNotifier(options: CreateNotifierOptions): Notifier {
	const { webhookUrl, logger } = options;
	if (!webhookUrl) {
		return createNoopNotifier(logger);
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		async notify(notification: Notification): Promise<boolean> {
			const body = JSON.stringify({ embeds: [buildEmbed(notification)] });

			let response: Response;
			try {
				response = await fetchImpl(webhookUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch {
				// fetch が投げる例外の message には webhook URL（トークンを含む）がそのまま
				// 含まれることがあるため、例外の内容は一切ログに出さない。
				logger.warn("Discord への送信に失敗しました（リクエストエラー）");
				return false;
			}

			if (!response.ok) {
				// 204 No Content は response.ok === true なのでここには来ない。
				// ボディは読まない（読もうとしても Discord 側は中身を返さない）。
				logger.warn("Discord への送信に失敗しました", {
					status: response.status,
				});
				return false;
			}

			return true;
		},
	};
}

/**
 * 環境変数から Webhook URL を読む。
 *
 * @param env テスト容易性のため差し替え可能にしている。省略時は `process.env`。
 */
export function loadWebhookUrl(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const value = env.DISCORD_WEBHOOK_URL?.trim();
	return value ? value : undefined;
}
