
export default class Multicast {
	private listeners: Function[] = [];

	add(func: Function) {
		this.listeners.push(func);
	};

	remove(func: Function) {
		this.listeners = this.listeners.filter((f) => func !== f);
	}

	fire(...args: any[]) {
		this.listeners.forEach((func: Function) => func.apply(null, args));
	}
}
