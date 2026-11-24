import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.data/**"],
	},
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
			"indent": ["error", "tab", { flatTernaryExpressions: true, SwitchCase: 1 }],
			"eqeqeq": ["error", "always"],
			"no-var": "error",
			"prefer-const": "error",
		},
	},
	{
		files: ["**/test/**/*.ts"],
		rules: {
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
);
