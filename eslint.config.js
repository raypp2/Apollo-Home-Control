const globals = require("globals");

module.exports = [
	{
		files: ["**/*.js"],
		ignores: ["public/**"],
		languageOptions: {
			ecmaVersion: 2020,
			sourceType: "commonjs",
			globals: {
				...globals.node,
				http: "readonly",
			}
		},
		rules: {
			"no-undef": "error",
			"no-dupe-keys": "error",
			"no-duplicate-case": "error",
			"no-unreachable": "error",
			"no-constant-condition": "error",
			"no-self-assign": "error",
			"eqeqeq": ["warn", "smart"],

			"no-unused-vars": ["warn", { "args": "none", "caughtErrors": "none" }],
			"no-var": "warn",
			"prefer-const": ["warn", { "destructuring": "all" }],
			"no-redeclare": "warn",
		}
	},
	{
		ignores: ["node_modules/", "public/"]
	}
];
