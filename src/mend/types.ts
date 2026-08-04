/**
 * cookiejar から取得した Cookie。ブラウザの Cookie 型と同じ構造。
 */
export interface Cookie {
	readonly name: string;
	readonly value: string;
	readonly domain: string;
	readonly path: string;
	readonly expires: number;
	readonly httpOnly: boolean;
	readonly secure: boolean;
	readonly sameSite: "Strict" | "Lax" | "None";
}

/**
 * Mend 側の Renovate の有効状態。
 *
 * Mend は `onboarding` / `onboarded` / `activated` / `disabled` などの文字列を返すが、
 * 値の集合は公開されておらず将来増える可能性がある。判別できなかった値は握りつぶさず
 * `unknown` として raw を保持し、突合側で「対象外」として安全に扱えるようにする。
 */
export type MendRenovateStatus =
	| { readonly kind: "enabled" }
	| { readonly kind: "disabled" }
	| { readonly kind: "unknown"; readonly raw: string };

/**
 * Mend 側のリポジトリ。SCA / SAST ではなく Renovate の状態のみを見る。
 */
export interface MendRepo {
	/** Mend が認識している名前（org を含まない repo 名）。 */
	readonly name: string;
	readonly renovateStatus: MendRenovateStatus;
}

/**
 * scan トリガーの結果。
 *
 * 個別リポジトリの失敗は例外ではなくこの戻り値で表現する。セッション全体が壊れた場合のみ
 * {@link MendAuthError} を throw する、という 2 段構えが終了コード設計の土台になっている。
 */
export type MendTriggerResult =
	| {
			readonly ok: true;
			/**
			 * 409 Conflict（ジョブが既にキューにある）だった場合に true。
			 * 前回の実行などで既にトリガー済みという意味なので、新規トリガーとは区別して数える。
			 */
			readonly alreadyQueued?: boolean;
	  }
	| { readonly ok: false; readonly reason: string };

/**
 * Mend のセッションを確立できない、または確立済みのセッションが失効した。
 * これが投げられた時点で以降の org を処理しても全滅が確定しているため、呼び出し側は即座に中断する。
 */
export class MendAuthError extends Error {
	override readonly name = "MendAuthError";
}

/**
 * Mend の内部 API が 401/403 以外のエラーステータスを返した。
 * リポジトリ・org 単位の失敗なので、呼び出し側は処理を継続する（fatal にしない）。
 * 診断のため、レスポンスボディの先頭を bodyPreview に保持する。
 */
export class MendApiError extends Error {
	override readonly name = "MendApiError";
	constructor(
		message: string,
		readonly status: number,
		readonly bodyPreview: string,
	) {
		super(message);
	}
}

/**
 * Mend の内部 API が成功を返したものの、レスポンスの構造が想定と異なる。
 * 内部 API の構造変更を意味し、他のリポジトリ・org でも同様に失敗すると見込まれるため
 * リトライしても直らないので fail fast させる。
 */
export class MendUiError extends Error {
	override readonly name = "MendUiError";
}

export interface MendClient extends AsyncDisposable {
	/** 指定 org の全リポジトリと、その Renovate 状態を返す。 */
	listRepos(org: string): Promise<readonly MendRepo[]>;
	/** 「Run Renovate scan」に相当する操作を実行する。scan の完了までは待たない。 */
	triggerScan(org: string, mendRepoName: string): Promise<MendTriggerResult>;
}

export type MendClientFactory = () => Promise<MendClient>;
