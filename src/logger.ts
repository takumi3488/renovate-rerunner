export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
	readonly verbose: boolean;
	/** テスト用の差し替え口。省略時は console.log / console.error。 */
	readonly sink?: (line: string) => void;
	/** 省略時は `!process.stdout.isTTY || process.env.LOG_FORMAT === "json"` で自動判定。 */
	readonly json?: boolean;
	/** テストで固定するための時刻取得口。省略時は `() => new Date().toISOString()`。 */
	readonly now?: () => string;
}

/** JSON ログの予約キー。fields 側に同名キーがあってもこちらを優先する。 */
const RESERVED_KEYS = new Set(["ts", "level", "msg"]);

/** Cookie・パスワード・トークン・TOTP secret などがログにそのまま漏れる事故を防ぐためのキー名パターン。 */
const SECRET_KEY_PATTERN = /cookie|password|token|secret|authorization|totp/i;

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * キー名に機密性を示す語を含むフィールドの値を伏せ字にする。
 * Cookie や TOTP secret が誤ってログに出力される事故を防ぐための必須処理なので、
 * ログ出力経路（人間可読・JSON の両方）から必ず通す。
 */
export function redactFields(
	fields: Record<string, unknown>,
): Record<string, unknown> {
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		redacted[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : value;
	}
	return redacted;
}

function formatValue(value: unknown): string {
	// 文字列はそのまま、それ以外は JSON.stringify して読みやすくする
	return typeof value === "string" ? value : JSON.stringify(value);
}

function formatHuman(
	level: LogLevel,
	msg: string,
	fields?: Record<string, unknown>,
): string {
	const entries = fields ? Object.entries(redactFields(fields)) : [];
	if (entries.length === 0) return `[${level}] ${msg}`;
	const suffix = entries
		.map(([key, value]) => `${key}=${formatValue(value)}`)
		.join(" ");
	return `[${level}] ${msg} ${suffix}`;
}

function formatJson(
	now: () => string,
	level: LogLevel,
	msg: string,
	fields?: Record<string, unknown>,
): string {
	const redacted = fields ? redactFields(fields) : {};
	// ts/level/msg は予約キー。fields 側に同名キーが来ても上書きさせないよう先に取り除く
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(redacted)) {
		if (RESERVED_KEYS.has(key)) continue;
		extra[key] = value;
	}
	return JSON.stringify({ ts: now(), level, msg, ...extra });
}

/**
 * 依存を増やさない最小ロガー。
 *
 * 出力形式（JSON / 人間可読）は TTY 判定で自動的に切り替える。CLI 引数として露出させないのは、
 * パイプやリダイレクトに応じて自然に機械可読な形式へ切り替わってほしいため。
 */
export function createLogger(options: LoggerOptions): Logger {
	const { verbose, sink } = options;
	const now = options.now ?? (() => new Date().toISOString());
	const json =
		options.json ??
		(!process.stdout.isTTY || process.env.LOG_FORMAT === "json");

	const write = (line: string, toStderr: boolean): void => {
		if (sink) {
			sink(line);
			return;
		}
		if (toStderr) {
			console.error(line);
		} else {
			console.log(line);
		}
	};

	const emit = (
		level: LogLevel,
		msg: string,
		fields: Record<string, unknown> | undefined,
		toStderr: boolean,
	): void => {
		const line = json
			? formatJson(now, level, msg, fields)
			: formatHuman(level, msg, fields);
		write(line, toStderr);
	};

	return {
		debug(msg, fields) {
			// verbose でなければ debug は出さない
			if (!verbose) return;
			emit("debug", msg, fields, false);
		},
		info(msg, fields) {
			emit("info", msg, fields, false);
		},
		warn(msg, fields) {
			emit("warn", msg, fields, true);
		},
		error(msg, fields) {
			emit("error", msg, fields, true);
		},
	};
}
