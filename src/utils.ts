/**
 * Returns a GUID
 * RFC 4122 Version 4 Compliant solution:
 * http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 * @memberOf stingray
 * @return {string}
 */
 export function uuid4() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = Math.random()*16|0;
		const v = c === "x" ? r : (r&0x3|0x8);
		return v.toString(16);
	});
};

export function getTimestamp() {
	const date = new Date();
	const hh = date.getHours().toString().padStart(2,"0");
	const mm = date.getMinutes().toString().padStart(2,"0");
	const ss = date.getSeconds().toString().padStart(2,"0");
	const ms = date.getMilliseconds().toString().padStart(3,"0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

export class Multicast {
	private listeners: Function[] = [];

	add(func: Function) {
		this.listeners.push(func);
	};

	remove(func: Function) {
		this.listeners = this.listeners.filter((f) => func === f);
	}

	fire(...args: any[]) {
		this.listeners.forEach((func: Function) => func.apply(null, args));
	}
};