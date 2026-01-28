const GIT_REPO = 'http://github.com/miaohta/mediaimport.git';
const BRANCH = process.env['BRANCH'] || 'develop';

// Git branch used in deployment
let branchName = BRANCH || 'develop';
let devBranchName = BRANCH || 'develop';

// This is used in the post-deploy hook
let npmInstallCmd;
npmInstallCmd = "source /home/mediaimport/.bash_profile; export PATH=/home/mediaimport/bin:$PATH;";
npmInstallCmd += "rm -rf node_modules; /home/mediaimport/bin/npm install";

function prodPostDeployCommands() {
	let cmd = `git pull origin; git checkout ${branchName};`;
	cmd += `${npmInstallCmd};`;
	return cmd;
}

function devPostDeployCommands() {
	return `git pull origin; git checkout ${devBranchName}; ${npmInstallCmd}`;
}

// This is the PM2 configuration file.
// Configure application you want pm2 to manage in the apps[] array.
module.exports = {
	apps: [{
		name: 'mediainfo',
	}],
	// PM2 Deployment configuration.
	// See http://pm2.keymetrics.io/docs/usage/deployment/
	deploy: {
		production: {
			user: 'mediaimport',
			host: ['xxxxxxx'],
			repo: GIT_REPO,
			ref: `origin/${branchName}`, // the git remote branch to use
			path: '/home/mediaimport/mediainfo-app-prod',
			'pre-deploy': `git reset --hard`,
			'post-deploy': prodPostDeployCommands(),
		},
		development: {
			user: 'mediaimport',
			host: ['xxxxxxx'],
			repo: GIT_REPO,
			ref: `origin/${devBranchName}`, // the git remote branch to use
			path: '/home/mediaimport/mediainfo-app-dev',
			'pre-deploy': `git reset --hard`,
			'post-deploy': devPostDeployCommands(),
		}
	}
};
