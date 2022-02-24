import { ChildProcess, exec } from 'child_process';

export const killProcessTree = async (child: ChildProcess): Promise<boolean> => {
	if (process.platform !== 'win32') {
		child.kill();
		return Promise.resolve(true);
	}

	return new Promise<boolean>((resolve) => {
		exec(`taskkill /pid ${child.pid} /T /F`, (error) => {
			const code = error?.code || 0;
			resolve(code === 0);
		});
	});
};
