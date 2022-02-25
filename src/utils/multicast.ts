/**
 * A Multicast provides support for one-to-many function calls.
 * This is provided since vscode.Event cannot be used from within the debug adapter.
 */
export default class Multicast {
	private listeners: Function[] = [];

	/**
	 * Add a function to the listener list.
	 * @param func The listener to attach.
	 */
	add(func: Function) {
		this.listeners = [...this.listeners, func];
		this.listeners.push(func);
	};

	/**
	 * Remove a function from the listener list.
	 * @param func The listener to detach.
	 */
	remove(func: Function) {
		const index = this.listeners.indexOf(func);
		this.listeners = this.listeners.filter((_, i) => i !== index);
	}

	/**
	 * Trigger the multicast, calling all listeners.
	 * Listeners are called in the order they were added.
	 * It is allowed to add/remove listeners while this function is being executed.
	 * @param args Arguments to the listeners.
	 */
	fire(...args: any[]) {
		this.listeners.forEach((func: Function) => func.apply(null, args));
	}
}
