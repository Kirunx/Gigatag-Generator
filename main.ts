import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Vault
} from "obsidian";


interface MyPluginSettings {
	mySetting: string;
	tagColors: Record<string, string>;
	expandedTags: string[];
	graphSettings: {
		gravity: number;
		repelling: number;
		linkDistance: number;
		charge: number;
		centerStrength: number;
		showTagConnections: boolean;
	};
	layout: {
		col1: number;
		col2: number;
		col3: number;
		row1: number;
		row2: number;
	};
	tags: Record<string, {
		color: string;
		files: string[];
		lastUsed: number;
		count: number;
	}>;
	tagSortOrder: 'name' | 'count' | 'recent';
	tagSearchQuery: string;
	// Add LLM settings
	llmSettings: {
		useManualPrompting: boolean;
		apiKey: string;
		model: string;
		endpoint: string;
		temperature: number;
		maxTokens: number;
		systemPrompt: string;
		analyzeForNewTags: boolean;
		fitToExistingTags: boolean;
		generateConnections: boolean;
	};
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	tagColors: {},
	expandedTags: [],
	graphSettings: {
		gravity: 0.1,
		repelling: 100,
		linkDistance: 100,
		charge: -30,
		centerStrength: 0.1,
		showTagConnections: false
	},
	layout: {
		col1: 38.29,
		col2: 37.60,
		col3: 24.12,
		row1: 66.84,
		row2: 33.16
	},
	tags: {},
	tagSortOrder: 'count',
	tagSearchQuery: '',
	// Add default LLM settings
	llmSettings: {
		useManualPrompting: false,
		apiKey: '',
		model: 'gpt-3.5-turbo',
		endpoint: 'https://api.openai.com/v1/chat/completions',
		temperature: 0.7,
		maxTokens: 1000,
		systemPrompt: 'You are an expert at analyzing notes and creating meaningful connections. Analyze the provided notes and suggest tags and connections.',
		analyzeForNewTags: true,
		fitToExistingTags: true,
		generateConnections: true
	}
};

interface FileSummary {
	file: string;
	content: string;
	links: string[];
}
function buildVaultTree(app: App): TreeNode {
	const root: TreeNode = {
		name: "",
		path: "",
		isFolder: true,
		children: []
	};

	// cache for folder nodes by absolute path
	const folderMap = new Map<string, TreeNode>();
	folderMap.set("", root);

	// create a folder TreeNode, recursively ensuring all parents exist
	function getOrCreateFolder(path: string): TreeNode {
		if (folderMap.has(path)) return folderMap.get(path)!;

		const parts = path.split("/").filter(x => x.length > 0);

		let currentPath = "";
		let parent = root;

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (!folderMap.has(currentPath)) {
				const node: TreeNode = {
					name: part,
					path: currentPath,
					isFolder: true,
					children: []
				};
				folderMap.set(currentPath, node);

				// attach to its parent
				parent.children.push(node);
			}

			parent = folderMap.get(currentPath)!;
		}

		return parent;
	}

	// Add all markdown files
	for (const f of app.vault.getMarkdownFiles()) {
		const full = f.path;        // 'folder1/folder2/file.md'
		const dirname = f.parent?.path ?? "";
		const filename = f.basename;

		const folderNode = getOrCreateFolder(dirname);

		const fileNode: TreeNode = {
			name: filename,
			path: full,
			isFolder: false,
			children: []
		};

		folderNode.children.push(fileNode);
	}

	// Sort children (folders first, then files, alphabetical)
	function sortRec(node: TreeNode) {
		node.children.sort((a, b) => {
			if (a.isFolder && !b.isFolder) return -1;
			if (!a.isFolder && b.isFolder) return 1;
			return a.name.localeCompare(b.name);
		});
		for (const c of node.children) {
			if (c.isFolder) sortRec(c);
		}
	}
	sortRec(root);

	return root;
}

/* Parse vault minimally: only files + outbound links */
async function parseVault(vault: Vault): Promise<Record<string, FileSummary>> {
	const out: Record<string, FileSummary> = {};
	for (const f of vault.getMarkdownFiles()) {
		const txt = await vault.cachedRead(f);

		const links = Array.from(txt.matchAll(/\[\[([^\]]+)\]\]/g)).map(
			m => m[1].split("|")[0]
		);

		out[f.path] = {
			file: f.basename,
			content: txt,
			links
		};
	}
	return out;
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	tagManager: TagManager;
	activeGraphView: GraphViewModal | null = null;
	async onload() {
		await this.loadSettings();
		this.tagManager = new TagManager(this);

		this.addRibbonIcon("dot-network", "Custom Graph", async () => {
			const data = await parseVault(this.app.vault);
			await this.tagManager.initialize(data);
			new GraphViewModal(this.app, this, data, this.tagManager).open();
		});

		this.addCommand({
			id: "open-custom-graph",
			name: "Open custom graph",
			callback: async () => {
				const data = await parseVault(this.app.vault);
				await this.tagManager.initialize(data);
				new GraphViewModal(this.app, this, data, this.tagManager).open();
			}
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}



}
interface TreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: TreeNode[];
}

import { GraphRenderer, GraphSettings, GraphNode, GraphTag } from './GraphRenderer';
class LLMPromptModal extends Modal {
	private plugin: MyPlugin;
	private data: Record<string, FileSummary>;
	private selectedNodes: Set<string>;
	private tagManager: TagManager;
	private generatedPrompt: string = '';
	private promptResult: string = '';
	private analysisOptions = {
		analyzeForNewTags: true,
		fitToExistingTags: true,
		generateConnections: true
	};

	constructor(app: App, plugin: MyPlugin, data: Record<string, FileSummary>, selectedNodes: Set<string>, tagManager: TagManager) {
		super(app);
		this.plugin = plugin;
		this.data = data;
		this.selectedNodes = selectedNodes;
		this.tagManager = tagManager;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('llm-prompt-modal');

		// Create header
		contentEl.createEl('h2', { text: 'LLM Analysis & Tag Generation' });

		// Create options section
		const optionsSection = contentEl.createDiv({ cls: 'llm-options' });
		optionsSection.createEl('h3', { text: 'Analysis Options' });

		// Create checkboxes for analysis options
		const optionsContainer = optionsSection.createDiv({ cls: 'options-container' });

		// Option 1: Analyze for new tags
		const newTagsOption = optionsContainer.createDiv({ cls: 'option-item' });
		const newTagsCheckbox = newTagsOption.createEl('input', {
			type: 'checkbox',
			attr: {
				id: 'new-tags-option'
			}
		}) as HTMLInputElement;
		newTagsCheckbox.checked = this.plugin.settings.llmSettings.analyzeForNewTags;
		const newTagsLabel = newTagsOption.createEl('label', {
			text: 'Analyze content for new tags'
		});
		newTagsLabel.htmlFor = 'new-tags-option';

		// Option 2: Fit to existing tags
		const existingTagsOption = optionsContainer.createDiv({ cls: 'option-item' });
		const existingTagsCheckbox = existingTagsOption.createEl('input', {
			type: 'checkbox',
			attr: {
				id: 'existing-tags-option'
			}
		}) as HTMLInputElement;
		existingTagsCheckbox.checked = this.plugin.settings.llmSettings.fitToExistingTags;
		const existingTagsLabel = existingTagsOption.createEl('label', {
			text: 'Fit connections to existing tags'
		});
		existingTagsLabel.htmlFor = 'existing-tags-option';

		// Option 3: Generate connections
		const connectionsOption = optionsContainer.createDiv({ cls: 'option-item' });
		const connectionsCheckbox = connectionsOption.createEl('input', {
			type: 'checkbox',
			attr: {
				id: 'connections-option'
			}
		}) as HTMLInputElement;
		connectionsCheckbox.checked = this.plugin.settings.llmSettings.generateConnections;
		const connectionsLabel = connectionsOption.createEl('label', {
			text: 'Generate connections between notes'
		});
		connectionsLabel.htmlFor = 'connections-option';

		// Update analysis options when checkboxes change
		newTagsCheckbox.onchange = () => this.analysisOptions.analyzeForNewTags = newTagsCheckbox.checked;
		existingTagsCheckbox.onchange = () => this.analysisOptions.fitToExistingTags = existingTagsCheckbox.checked;
		connectionsCheckbox.onchange = () => this.analysisOptions.generateConnections = connectionsCheckbox.checked;

		// Create action buttons
		const actionButtons = contentEl.createDiv({ cls: 'action-buttons' });

		// Generate button
		const generateBtn = actionButtons.createEl('button', {
			cls: 'btn primary',
			text: 'Generate Prompt'
		});

		generateBtn.onclick = async () => {
			await this.generatePrompt();
		};

		// Create prompt section
		const promptSection = contentEl.createDiv({ cls: 'prompt-section' });
		promptSection.createEl('h3', { text: 'Generated Prompt' });

		const promptContainer = promptSection.createDiv({ cls: 'prompt-container' });
		const promptTextarea = promptContainer.createEl('textarea', {
			cls: 'prompt-textarea',
			attr: {
				readonly: 'readonly',
				placeholder: 'Click "Generate Prompt" to create a prompt based on selected notes...'
			}
		}) as HTMLTextAreaElement;

		// Copy button
		const copyBtn = promptContainer.createEl('button', {
			cls: 'btn copy-btn',
			text: 'Copy Prompt'
		});

		copyBtn.onclick = () => {
			navigator.clipboard.writeText(promptTextarea.value).then(() => {
				new Notice('Prompt copied to clipboard!');
			});
		};

		// Create result section
		const resultSection = contentEl.createDiv({ cls: 'result-section' });
		resultSection.createEl('h3', { text: 'Paste LLM Result' });

		const resultContainer = resultSection.createDiv({ cls: 'result-container' });
		const resultTextarea = resultContainer.createEl('textarea', {
			cls: 'result-textarea',
			attr: {
				placeholder: 'Paste the LLM response here...'
			}
		}) as HTMLTextAreaElement;

		resultTextarea.oninput = (e) => {
			this.promptResult = (e.target as HTMLTextAreaElement).value;
		};

		// Create execution buttons
		const executionButtons = contentEl.createDiv({ cls: 'execution-buttons' });

		// Execute button
		const executeBtn = executionButtons.createEl('button', {
			cls: 'btn primary',
			text: 'Execute Result'
		});

		executeBtn.onclick = async () => {
			await this.executeResult();
		};

		// Close button
		const closeBtn = executionButtons.createEl('button', {
			cls: 'btn',
			text: 'Close'
		});

		closeBtn.onclick = () => {
			this.close();
		};

		// Store references
		(this as any).promptTextarea = promptTextarea;
		(this as any).resultTextarea = resultTextarea;
	}

	private async generatePrompt() {
		try {
			// Get minimal JSON for selected notes
			const notesData = await this.createMinimalJSON();

			// Get existing tags for context
			const existingTags = Array.from(this.tagManager.getTags().keys());

			// Build the prompt based on selected options
			let prompt = this.buildPrompt(notesData, existingTags);

			this.generatedPrompt = prompt;

			// Update textarea
			const promptTextarea = (this as any).promptTextarea;
			if (promptTextarea) {
				promptTextarea.value = prompt;
			}

			new Notice('Prompt generated successfully!');

		} catch (error) {
			console.error('Error generating prompt:', error);
			new Notice('Failed to generate prompt');
		}
	}

	private async createMinimalJSON(): Promise<any[]> {
		const notesData = [];

		for (const filePath of Array.from(this.selectedNodes)) {
			const fileSummary = this.data[filePath];
			if (!fileSummary) continue;

			// Extract first few lines as "header" (content before first blank line or first 3 lines)
			const lines = fileSummary.content.split('\n');
			let header = '';
			let lineCount = 0;

			for (const line of lines) {
				if (line.trim() === '' && lineCount > 0) break;
				if (lineCount >= 5) break; // Limit to 5 lines

				header += line + '\n';
				lineCount++;
			}

			// Get tags for this file
			const tags = this.extractFileTags(filePath);

			notesData.push({
				fileName: fileSummary.file,
				path: filePath,
				header: header.trim(),
				tags: tags,
				linkCount: fileSummary.links.length,
				wordCount: fileSummary.content.split(/\s+/).length
			});
		}

		return notesData;
	}

	private extractFileTags(filePath: string): string[] {
		const fileSummary = this.data[filePath];
		if (!fileSummary) return [];

		const tags = new Set<string>();
		const content = fileSummary.content;
		const lines = content.split('\n');

		for (const line of lines) {
			if (line.trim().startsWith('```') ||
				line.includes('`') && line.split('`').length % 2 === 0) {
				continue;
			}

			const tagMatches = line.matchAll(/(?:^|\s)#([a-zA-Zа-яА-ЯёЁ][a-zA-Zа-яА-ЯёЁ0-9_-]*)/g);
			for (const match of tagMatches) {
				const tagName = match[1].toLowerCase();
				if (tagName && tagName.length > 0) {
					const falsePositives = ['include', 'define', 'ifndef', 'ifdef', 'endif', 'pragma'];
					if (!falsePositives.includes(tagName)) {
						tags.add(tagName);
					}
				}
			}
		}

		return Array.from(tags);
	}

	private buildPrompt(notesData: any[], existingTags: string[]): string {
		const options = this.analysisOptions;
		const systemPrompt = this.plugin.settings.llmSettings.systemPrompt;

		let prompt = `${systemPrompt}\n\n`;
		prompt += `I have ${notesData.length} notes that I want to analyze. Here's the data:\n\n`;

		// Add notes data
		prompt += JSON.stringify(notesData, null, 2) + '\n\n';

		// Add existing tags if relevant
		if (existingTags.length > 0 && (options.fitToExistingTags || options.analyzeForNewTags)) {
			prompt += `Existing tags in the vault: ${existingTags.join(', ')}\n\n`;
		}

		prompt += `Please analyze these notes and provide the following:\n`;

		if (options.analyzeForNewTags) {
			prompt += `1. Suggest NEW tags that would be relevant for these notes.\n`;
			prompt += `   Format: [{"fileName": "note.md", "suggestedTags": ["tag1", "tag2"]}, ...]\n`;
		}

		if (options.fitToExistingTags) {
			prompt += `2. Suggest which EXISTING tags should be added to which notes.\n`;
			prompt += `   Format: [{"tag": "existingTag", "notes": ["note1.md", "note2.md"]}, ...]\n`;
		}

		if (options.generateConnections) {
			prompt += `3. Suggest CONNECTIONS between notes that aren't currently linked.\n`;
			prompt += `   Format: [{"source": "note1.md", "target": "note2.md", "reason": "brief explanation"}, ...]\n`;
		}

		prompt += `\nPlease respond ONLY with a JSON array containing all suggestions in this format:\n`;
		prompt += `{\n`;
		prompt += `  "newTags": [...],  // if analyzeForNewTags is true\n`;
		prompt += `  "existingTagAssignments": [...],  // if fitToExistingTags is true\n`;
		prompt += `  "connections": [...]  // if generateConnections is true\n`;
		prompt += `}\n`;

		return prompt;
	}
	private async executeResult() {
		try {
			if (!this.promptResult.trim()) {
				new Notice('Please paste an LLM response first');
				return;
			}
	
			let result;
			let validationError = '';
			
			try {
				result = JSON.parse(this.promptResult.trim());
			} catch (e) {
				// Try to extract JSON if it's wrapped in markdown code blocks
				const jsonMatch = this.promptResult.match(/```(?:json)?\n([\s\S]*?)\n```/);
				if (jsonMatch) {
					try {
						result = JSON.parse(jsonMatch[1]);
					} catch (e2) {
						validationError = 'Invalid JSON in code block';
					}
				} else {
					validationError = 'Invalid JSON format';
				}
			}
	
			if (validationError || !result) {
				new Notice(`${validationError}. Please check the JSON format.`);
				return;
			}
	
			// Validate the result format
			const validation = this.validateLLMResult(result);
			if (!validation.valid) {
				new Notice(`Validation failed: ${validation.message}`);
				return;
			}
	
			// Process the results
			await this.processLLMResult(validation.result);
	
			new Notice('LLM results processed successfully!');
			this.close();
	
		} catch (error) {
			console.error('Error executing result:', error);
			new Notice('Failed to process LLM result: ' + error.message);
		}
	}
	private validateLLMResult(result: any): { valid: boolean; message: string; result: any } {
		// Handle array format (incorrect but common)
		if (Array.isArray(result)) {
			const converted = this.convertArrayFormatToExpectedFormat(result);
			return this.validateExpectedFormat(converted);
		}
		
		return this.validateExpectedFormat(result);
	}

	private validateExpectedFormat(result: any): { valid: boolean; message: string; result: any } {
		const validatedResult: any = {
			newTags: [],
			existingTagAssignments: [],
			connections: []
		};
		
		let valid = true;
		let message = '';
		
		// Check newTags
		if (result.newTags !== undefined) {
			if (Array.isArray(result.newTags)) {
				// Validate each new tag entry
				validatedResult.newTags = result.newTags.filter((item: any) => {
					return item && item.fileName && Array.isArray(item.suggestedTags);
				});
				
				if (validatedResult.newTags.length !== result.newTags.length) {
					message += 'Some newTags entries were invalid. ';
				}
			} else {
				valid = false;
				message += 'newTags must be an array. ';
			}
		}
		
		// Check existingTagAssignments
		if (result.existingTagAssignments !== undefined) {
			if (Array.isArray(result.existingTagAssignments)) {
				// Validate each assignment
				validatedResult.existingTagAssignments = result.existingTagAssignments.filter((item: any) => {
					return item && item.tag && Array.isArray(item.notes);
				});
				
				if (validatedResult.existingTagAssignments.length !== result.existingTagAssignments.length) {
					message += 'Some existingTagAssignments entries were invalid. ';
				}
			} else {
				valid = false;
				message += 'existingTagAssignments must be an array. ';
			}
		}
		
		// Check connections
		if (result.connections !== undefined) {
			if (Array.isArray(result.connections)) {
				// Validate each connection
				validatedResult.connections = result.connections.filter((item: any) => {
					return item && item.source && item.target;
				});
				
				if (validatedResult.connections.length !== result.connections.length) {
					message += 'Some connections entries were invalid. ';
				}
			} else {
				valid = false;
				message += 'connections must be an array. ';
			}
		}
		
		// If nothing was provided, it's invalid
		if (!result.newTags && !result.existingTagAssignments && !result.connections) {
			valid = false;
			message = 'No valid data found in LLM response. Expected format: {"newTags": [...], "existingTagAssignments": [...], "connections": [...]}';
		}
		
		return {
			valid: valid && (validatedResult.newTags.length > 0 || validatedResult.existingTagAssignments.length > 0 || validatedResult.connections.length > 0),
			message: message || 'OK',
			result: validatedResult
		};
	}

	private convertArrayFormatToExpectedFormat(arrayResult: any[]): any {
		const result: {
			newTags: Array<{fileName: string, suggestedTags: string[]}>;
			existingTagAssignments: Array<{tag: string, notes: string[]}>;
			connections: Array<{source: string, target: string, reason?: string}>;
		} = {
			newTags: [],
			existingTagAssignments: [],
			connections: []
		};
	
		arrayResult.forEach(item => {
			if (item && typeof item === 'object') {
				if (item.fileName && Array.isArray(item.suggestedTags)) {
					result.newTags.push({
						fileName: item.fileName,
						suggestedTags: item.suggestedTags
					});
				} else if (item.source && item.target) {
					result.connections.push({
						source: item.source,
						target: item.target,
						reason: item.reason
					});
				} else if (item.tag && Array.isArray(item.notes)) {
					result.existingTagAssignments.push({
						tag: item.tag,
						notes: item.notes
					});
				}
			}
		});
	
		return result;
	}
	private async processLLMResult(result: any) {
		const vault = this.app.vault;
		let changesMade = false;
	
		// Process new tag suggestions
		if (result.newTags && Array.isArray(result.newTags)) {
			for (const suggestion of result.newTags) {
				if (suggestion.fileName && suggestion.suggestedTags) {
					// Find the file
					const fileName = suggestion.fileName.replace(/\.md$/, '');
					const file = this.app.vault.getMarkdownFiles()
						.find(f => f.basename === fileName);
	
					if (file) {
						// Read file
						const content = await vault.read(file);
						let newContent = content;
						let tagsAdded = false;
	
						// Add tags if they don't exist
						for (const tag of suggestion.suggestedTags) {
							const tagString = `#${tag}`;
							if (!content.includes(tagString)) {
								// Add tag at the end of the file or in a tags section
								if (newContent.includes('## Tags') || newContent.includes('# Tags')) {
									// Add to existing tags section
									newContent = newContent.replace(
										/(##? Tags\n)([\s\S]*?)(?=\n##|$)/,
										(match, p1, p2) => `${p1}${p2}${p2.trim() ? ' ' : ''}${tagString} `
									);
								} else {
									// Add new tags section at the end
									newContent += `\n\n## Tags\n${tagString} `;
								}
								tagsAdded = true;
							}
						}
	
						// Write back if changed
						if (tagsAdded) {
							await vault.modify(file, newContent);
							changesMade = true;
							console.log(`Added tags to ${fileName}:`, suggestion.suggestedTags);
						}
					}
				}
			}
		}
	
		// Process existing tag assignments
		if (result.existingTagAssignments && Array.isArray(result.existingTagAssignments)) {
			for (const assignment of result.existingTagAssignments) {
				if (assignment.tag && assignment.notes) {
					for (const noteName of assignment.notes) {
						const fileName = noteName.replace(/\.md$/, '');
						const file = this.app.vault.getMarkdownFiles()
							.find(f => f.basename === fileName);
	
						if (file) {
							const content = await vault.read(file);
							const tagString = `#${assignment.tag}`;
	
							if (!content.includes(tagString)) {
								let newContent = content;
								if (newContent.includes('## Tags') || newContent.includes('# Tags')) {
									newContent = newContent.replace(
										/(##? Tags\n)([\s\S]*?)(?=\n##|$)/,
										(match, p1, p2) => `${p1}${p2}${p2.trim() ? ' ' : ''}${tagString} `
									);
								} else {
									newContent += `\n\n## Tags\n${tagString} `;
								}
	
								await vault.modify(file, newContent);
								changesMade = true;
								console.log(`Added tag ${assignment.tag} to ${fileName}`);
							}
						}
					}
				}
			}
		}
	
		// Process connections (add wiki links)
		if (result.connections && Array.isArray(result.connections)) {
			for (const connection of result.connections) {
				if (connection.source && connection.target) {
					const sourceFileName = connection.source.replace(/\.md$/, '');
					const targetFileName = connection.target.replace(/\.md$/, '');
					
					const sourceFile = this.app.vault.getMarkdownFiles()
						.find(f => f.basename === sourceFileName);
					const targetFile = this.app.vault.getMarkdownFiles()
						.find(f => f.basename === targetFileName);
	
					if (sourceFile && targetFile) {
						const content = await vault.read(sourceFile);
						const linkString = `[[${targetFileName}]]`;
	
						if (!content.includes(linkString)) {
							let newContent = content;
							if (newContent.includes('## Related') || newContent.includes('# Related')) {
								newContent = newContent.replace(
									/(##? Related\n)([\s\S]*?)(?=\n##|$)/,
									(match, p1, p2) => `${p1}${p2}${p2.trim() ? '\n' : ''}- ${linkString}`
								);
							} else {
								newContent += `\n\n## Related\n- ${linkString}`;
							}
	
							await vault.modify(sourceFile, newContent);
							changesMade = true;
							console.log(`Added link from ${sourceFileName} to ${targetFileName}`);
						}
					}
				}
			}
		}
	
		if (changesMade) {
			// Refresh the graph view AND file tree
			if (this.plugin.activeGraphView) {
				// First refresh the graph to update connections
				this.plugin.activeGraphView.refreshGraph();
				
				// Then refresh the file tree to show new tags
				this.plugin.activeGraphView.refreshFileTags();
				
				// Also refresh tag list
				this.plugin.activeGraphView.refreshTagList();
			}
			
			// Show summary notice
			const summary = [];
			if (result.newTags?.length) summary.push(`${result.newTags.length} new tags`);
			if (result.existingTagAssignments?.length) summary.push(`${result.existingTagAssignments.length} tag assignments`);
			if (result.connections?.length) summary.push(`${result.connections.length} connections`);
			
			if (summary.length > 0) {
				new Notice(`Applied: ${summary.join(', ')}`);
			}
		} else {
			new Notice('No changes were made (all suggestions already exist)');
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class GraphViewModal extends Modal {
	data: Record<string, FileSummary>;
	selectedNodes: Set<string> = new Set();
	treeRoot: TreeNode;
	fileTreeEl: HTMLElement | null = null;
	expanded = new Set<string>();
	private showSettings = false;
	private plugin: MyPlugin;
	private tagManager: TagManager;
	private graphRenderer: GraphRenderer | null = null;
	private graphContainer: HTMLElement | null = null;
	private tagSearchInput: HTMLInputElement | null = null;
	private tagSortOrder: 'name' | 'count' | 'recent' = 'count';
	private activeGraphView: GraphViewModal | null = null;
	constructor(app: App, plugin: MyPlugin, data: Record<string, FileSummary>, tagManager: TagManager) {
		super(app);
		this.plugin = plugin;
		this.data = data;
		this.tagManager = tagManager;
		this.treeRoot = buildVaultTree(app);
		this.modalEl.addClass("graph-view-modal");
		this.expanded.add("");
		this.loadLayout();
	}
	private loadLayout() {
		const layout = this.plugin.settings.layout;
		if (layout) {
			this.modalEl.style.setProperty("--col1", layout.col1.toString());
			this.modalEl.style.setProperty("--col2", layout.col2.toString());
			this.modalEl.style.setProperty("--col3", layout.col3.toString());
			this.modalEl.style.setProperty("--row1", layout.row1.toString());
			this.modalEl.style.setProperty("--row2", layout.row2.toString());
		}
	}
	public refreshFileTags() {
		if (this.fileTreeEl) {
			// Re-render the tree to show updated tags
			this.renderTree(this.treeRoot, this.fileTreeEl);
			
			// Also update the graph data
			if (this.graphRenderer) {
				// Re-parse vault data to get updated tags
				parseVault(this.app.vault).then(newData => {
					this.data = newData;
					this.tagManager.extractAndUpdateTags(newData);
					this.refreshGraph();
				});
			}
		}
	}
	private async saveLayout() {
		const computedStyle = getComputedStyle(this.modalEl);
		this.plugin.settings.layout = {
			col1: parseFloat(computedStyle.getPropertyValue('--col1')),
			col2: parseFloat(computedStyle.getPropertyValue('--col2')),
			col3: parseFloat(computedStyle.getPropertyValue('--col3')),
			row1: parseFloat(computedStyle.getPropertyValue('--row1')),
			row2: parseFloat(computedStyle.getPropertyValue('--row2'))
		};
		await this.plugin.saveSettings();
	}
	renderTree(node: TreeNode, parentEl: HTMLElement) {
		if (parentEl === this.fileTreeEl && node === this.treeRoot) {
			parentEl.empty();
		}
		
		for (const child of node.children) {
			const li = parentEl.createEl("li");
			li.addClass(child.isFolder ? "folder" : "file");

			if (child.isFolder) {
				/* ---------------- FOLDER ---------------- */
				const header = li.createDiv({ cls: "folder-header" });

				// caret
				const caret = header.createDiv({ cls: "caret", text: "▶" });
				const isExpanded = this.expanded.has(child.path);
				if (isExpanded) caret.style.transform = "rotate(90deg)";

				// folder label
				const label = header.createDiv({ cls: "folder-label", text: child.name });

				// selection state
				if (this.selectedNodes.has(child.path)) header.addClass("selected");

				// children container
				const childUl = li.createEl("ul");
				if (!isExpanded) childUl.style.display = "none";

				// toggle expand
				const toggle = () => {
					if (this.expanded.has(child.path)) {
						this.expanded.delete(child.path);
						childUl.style.display = "none";
						caret.style.transform = "";
					} else {
						this.expanded.add(child.path);
						childUl.style.display = "";
						caret.style.transform = "rotate(90deg)";
					}
				};
				caret.onclick = (e) => { e.stopPropagation(); toggle(); };
				label.onclick = (e) => { e.stopPropagation(); toggle(); };

				this.renderTree(child, childUl);

			} else {
				/* ---------------- FILE ---------------- */
				const row = li.createDiv({ cls: "file-row" });

				// File name container
				const fileNameContainer = row.createDiv({ cls: "file-name-container" });
				fileNameContainer.createSpan({ cls: "file-name", text: child.name });

				// Extract and display tags for this file
				const tags = this.extractFileTags(child.path);
				if (tags.length > 0) {
					const tagContainer = row.createDiv({ cls: "file-tags-container" });
					tags.forEach(tag => {
						// Get color for this tag
						const tagColor = this.getTagColorForDisplay(tag);

						const tagEl = tagContainer.createSpan({
							cls: "file-tag",
							text: `#${tag}`
						});
						tagEl.style.backgroundColor = tagColor + '40'; // 40 = 25% opacity
						tagEl.style.color = tagColor;
					});
				}

				if (this.selectedNodes.has(child.path)) row.addClass("selected");

				row.onclick = () => {
					const wasSelected = this.selectedNodes.has(child.path);
					if (wasSelected) {
						this.selectedNodes.delete(child.path);
						row.removeClass("selected");
					} else {
						this.selectedNodes.add(child.path);
						row.addClass("selected");
					}
					console.log(`File ${child.path} ${wasSelected ? 'deselected' : 'selected'}`);
					this.refreshGraph();
					this.refreshTagList(); // Also refresh tag list when selection changes
				};
			}
		}
	}
	private extractFileTags(filePath: string): string[] {
		const fileSummary = this.data[filePath];
		if (!fileSummary) return [];

		const tags = new Set<string>();
		const content = fileSummary.content;
		const lines = content.split('\n');

		for (const line of lines) {
			// Skip code blocks
			if (line.trim().startsWith('```') ||
				line.includes('`') && line.split('`').length % 2 === 0) {
				continue;
			}

			// Match tags with Cyrillic support
			const tagMatches = line.matchAll(/(?:^|\s)#([a-zA-Zа-яА-ЯёЁ][a-zA-Zа-яА-ЯёЁ0-9_-]*)/g);
			for (const match of tagMatches) {
				const tagName = match[1].toLowerCase();
				if (tagName && tagName.length > 0) {
					// Skip false positives
					const falsePositives = ['include', 'define', 'ifndef', 'ifdef', 'endif', 'pragma'];
					if (!falsePositives.includes(tagName)) {
						tags.add(tagName);
					}
				}
			}
		}

		return Array.from(tags);
	}

	private convertToGraphTags(): Map<string, GraphTag> {
		const graphTags = new Map<string, GraphTag>();
		const tagMap = this.tagManager.getTags();

		tagMap.forEach((tagData, tagName) => {
			graphTags.set(tagName, {
				name: tagName,
				color: tagData.color,
				files: new Set(tagData.files) // Convert array to Set
			});
		});

		return graphTags;
	}

	private getTagColorForDisplay(tagName: string): string {
		if (this.graphRenderer) {
			const tag = this.graphRenderer.getTags().get(tagName);
			if (tag) {
				return this.getHexColor(tag.color);
			}
		}

		// Default color if not found
		return '#8a8a8a';
	}

	enableResize(gridEl: HTMLElement) {

		let dragging: "col1" | "col2" | "row1" | null = null;
		let startX = 0;
		let startY = 0;

		// pixel sizes captured at drag start
		let startC1 = 0, startC2 = 0, startC3 = 0;
		let startR1 = 0, startR2 = 0;
		let totalW = 0, totalH = 0;

		const v1 = gridEl.querySelector(".resize-v-1") as HTMLElement;
		const v2 = gridEl.querySelector(".resize-v-2") as HTMLElement;
		const h1 = gridEl.querySelector(".resize-h-1") as HTMLElement;

		function readSizesPx() {
			totalW = gridEl.clientWidth;
			totalH = gridEl.clientHeight;

			// get computed current percentages
			const c1p = parseFloat(getComputedStyle(gridEl).getPropertyValue("--col1"));
			const c2p = parseFloat(getComputedStyle(gridEl).getPropertyValue("--col2"));
			const c3p = parseFloat(getComputedStyle(gridEl).getPropertyValue("--col3"));

			const r1p = parseFloat(getComputedStyle(gridEl).getPropertyValue("--row1"));
			const r2p = parseFloat(getComputedStyle(gridEl).getPropertyValue("--row2"));

			// convert to px for stable math
			startC1 = totalW * (c1p / 100);
			startC2 = totalW * (c2p / 100);
			startC3 = totalW * (c3p / 100);

			startR1 = totalH * (r1p / 100);
			startR2 = totalH * (r2p / 100);
		}

		function updateGrid(c1: number, c2: number, c3: number, r1: number, r2: number) {
			const c1p = (c1 / totalW) * 100;
			const c2p = (c2 / totalW) * 100;
			const c3p = (c3 / totalW) * 100;

			const r1p = (r1 / totalH) * 100;
			const r2p = (r2 / totalH) * 100;

			gridEl.style.gridTemplateColumns = `${c1p}% ${c2p}% ${c3p}%`;
			gridEl.style.gridTemplateRows = `${r1p}% ${r2p}%`;

			gridEl.style.setProperty("--col1", c1p.toString());
			gridEl.style.setProperty("--col2", c2p.toString());
			gridEl.style.setProperty("--col3", c3p.toString());

			gridEl.style.setProperty("--row1", r1p.toString());
			gridEl.style.setProperty("--row2", r2p.toString());
		}
		// --- Drag start ---
		v1.onmousedown = e => {
			dragging = "col1";
			startX = e.clientX;
			readSizesPx();
			e.preventDefault();
		};
		v2.onmousedown = e => {
			dragging = "col2";
			startX = e.clientX;
			readSizesPx();
			e.preventDefault();
		};
		h1.onmousedown = e => {
			dragging = "row1";
			startY = e.clientY;
			readSizesPx();
			e.preventDefault();
		};
		document.onmousemove = e => {
			if (!dragging) return;

			if (dragging === "col1") {
				const dx = e.clientX - startX;

				const newC1 = startC1 + dx;
				const newC2 = startC2 - dx;

				if (newC1 > 80 && newC2 > 80) {
					updateGrid(newC1, newC2, startC3, startR1, startR2);
				}
			}

			if (dragging === "col2") {
				const dx = e.clientX - startX;

				const newC2 = startC2 + dx;
				const newC3 = startC3 - dx;

				if (newC2 > 80 && newC3 > 80) {
					updateGrid(startC1, newC2, newC3, startR1, startR2);
				}
			}

			if (dragging === "row1") {
				const dy = e.clientY - startY;

				const newR1 = startR1 + dy;
				const newR2 = startR2 - dy;

				if (newR1 > 60 && newR2 > 60) {
					updateGrid(startC1, startC2, startC3, newR1, newR2);
				}
			}
		};


		document.onmouseup = () => {
			dragging = null;
		};
		document.onmouseup = async () => {
			if (dragging) {
				await this.saveLayout();
			}
			dragging = null;
		};
	}
	private applyGraphSettings() {
		if (this.graphRenderer) {
			// Apply all saved settings to the graph renderer
			this.graphRenderer.settings = {
				...this.graphRenderer.settings,
				...this.plugin.settings.graphSettings
			};

			// Refresh the graph to apply settings
			this.refreshGraph();
		}
	}
	private initializeGraph() {
		this.graphContainer = this.contentEl.querySelector('.graph-view') as HTMLElement;
		if (!this.graphContainer) {
			console.error('Graph container not found');
			return;
		}

		this.graphContainer.style.width = '100%';
		this.graphContainer.style.height = '100%';
		this.graphContainer.style.minHeight = '400px';

		// Create settings panel
		this.createSettingsPanel(this.graphContainer);

		// Convert tags to GraphRenderer format
		const graphTags = this.convertToGraphTags();

		// Initialize graph renderer
		this.graphRenderer = new GraphRenderer(
			this.graphContainer,
			this.data,
			this.selectedNodes,
			graphTags,
			this.plugin.settings.graphSettings,
			(node: GraphNode) => this.handleNodeClick(node)
		);

		// Force an initial refresh
		setTimeout(() => {
			this.refreshGraph();
		}, 500);
	}

	private toggleSettings() {
		this.showSettings = !this.showSettings;
		const settingsPanel = this.graphContainer?.querySelector('.graph-settings');
		if (settingsPanel) {
			if (this.showSettings) {
				settingsPanel.classList.remove('hidden');
			} else {
				settingsPanel.classList.add('hidden');
			}
		}
	}

	private createSettingsPanel(container: HTMLElement) {
		// Create settings container with toggle button
		const settingsContainer = container.createDiv({ cls: 'graph-settings-container' });

		// Settings toggle button
		const settingsToggle = settingsContainer.createDiv({
			cls: 'settings-toggle-btn',
			text: '⚙️ Settings'
		});

		settingsToggle.onclick = () => this.toggleSettings();

		// Settings panel
		const settingsPanel = settingsContainer.createDiv({ cls: 'graph-settings hidden' });

		settingsPanel.createEl('h4', { text: 'Graph Settings' });

		// Create sliders - use plugin settings directly
		this.createSliders(settingsPanel);
	}

	private createSliders(settingsPanel: HTMLElement) {
		// Clear any existing sliders
		const existingSliders = settingsPanel.querySelectorAll('.setting-item');
		existingSliders.forEach(el => el.remove());

		// Create sliders with values from plugin settings
		this.createSlider(settingsPanel, 'Gravity', 'gravity', 0, 1, 0.01);
		this.createSlider(settingsPanel, 'Repelling Force', 'repelling', 1, 500, 1);
		this.createSlider(settingsPanel, 'Link Distance', 'linkDistance', 10, 300, 1);
		this.createSlider(settingsPanel, 'Charge', 'charge', -100, 0, 1);
		this.createSlider(settingsPanel, 'Center Strength', 'centerStrength', 0, 1, 0.01);

		// Add tag connections toggle
		const tagToggleContainer = settingsPanel.createDiv({ cls: 'setting-item' });
		const tagLabel = tagToggleContainer.createEl('label', { text: 'Show Tag Connections' });
		const tagToggle = tagToggleContainer.createEl('input', {
			type: 'checkbox'
		});

		// Set initial state from plugin settings
		tagToggle.checked = this.plugin.settings.graphSettings.showTagConnections;

		tagToggle.onchange = (e) => {
			// Update plugin settings
			this.plugin.settings.graphSettings.showTagConnections = (e.target as HTMLInputElement).checked;
			this.plugin.saveSettings();

			// Update graph renderer if it exists
			if (this.graphRenderer) {
				this.graphRenderer.settings.showTagConnections = this.plugin.settings.graphSettings.showTagConnections;
				this.refreshGraph();
			}
		};
	}

	private createSlider(container: HTMLElement, label: string, key: keyof GraphSettings, min: number, max: number, step: number) {
		const settingItem = container.createDiv({ cls: 'setting-item' });

		const labelEl = settingItem.createEl('label', { text: label });
		const valueDisplay = settingItem.createDiv({ cls: 'value-display' });

		// Get value from plugin settings
		const currentValue = this.plugin.settings.graphSettings[key] as number;
		const initialValue = currentValue !== undefined ? currentValue : min;

		const slider = settingItem.createEl('input', {
			type: 'range',
			attr: {
				min: min.toString(),
				max: max.toString(),
				step: step.toString(),
				value: initialValue.toString()
			}
		});

		// Set initial value display
		valueDisplay.textContent = initialValue.toFixed(2);

		slider.oninput = (e) => {
			const newValue = parseFloat((e.target as HTMLInputElement).value);

			// Update plugin settings
			(this.plugin.settings.graphSettings[key] as number) = newValue;
			this.plugin.saveSettings();

			valueDisplay.textContent = newValue.toFixed(2);

			// Update graph renderer if it exists
			if (this.graphRenderer) {
				(this.graphRenderer.settings[key] as number) = newValue;
				this.graphRenderer.updateSimulation();
			}
		};

		slider.onchange = slider.oninput;
	}

	private handleNodeClick(node: GraphNode) {
		// Handle node click - you can implement custom behavior here
		console.log('Node clicked:', node);

		// Example: Toggle selection in the file tree
		this.toggleFileSelection(node.path);
	}

	private toggleFileSelection(filePath: string) {
		if (this.selectedNodes.has(filePath)) {
			this.selectedNodes.delete(filePath);
		} else {
			this.selectedNodes.add(filePath);
		}
		this.refreshGraph();
		this.refreshFileTree();
	}

	public refreshGraph() {
		console.log('Refreshing graph with selected files:', Array.from(this.selectedNodes));
		const graphRenderer = this.graphRenderer; // Save reference

		if (graphRenderer) {
			// Re-parse the vault data
			parseVault(this.app.vault).then(newData => {
				this.data = newData;

				// Update tags in tag manager
				this.tagManager.extractAndUpdateTags(newData);

				// Convert to graph tags
				const graphTags = this.convertToGraphTags();

				// Save current settings before updating
				const currentSettings = { ...graphRenderer.settings }; // Use saved reference

				// Update graph renderer with new data
				graphRenderer.updateData(newData);
				graphRenderer.updateSelection(this.selectedNodes);
				graphRenderer.updateTags(graphTags);

				// Restore settings
				graphRenderer.settings = currentSettings;

				this.refreshTagList();
			});
		} else {
			this.initializeGraph();
		}
	}

	private refreshFileTree() {
		if (this.fileTreeEl) {
			this.renderTree(this.treeRoot, this.fileTreeEl);
		}
	}
	private getAllFiles(node: TreeNode): TreeNode[] {
		const files: TreeNode[] = [];
		if (!node.isFolder) {
			files.push(node);
		}
		node.children.forEach(child => {
			files.push(...this.getAllFiles(child));
		});
		return files;
	}
	private renderLLMPanel(llmPanel: HTMLElement) {
		llmPanel.empty();
		const llmHeader = llmPanel.createDiv({ cls: "panel-header" });
		llmHeader.createEl("span", { text: "LLM settings" });

		const llmContent = llmPanel.createDiv({ cls: "llm-content" });

		// Manual prompting checkbox
		const manualPromptingSetting = llmContent.createDiv({ cls: "setting-item" });
		const checkbox = manualPromptingSetting.createEl("input", {
			type: "checkbox"
		});
		checkbox.id = "manual-prompting"; // Set ID separately
		checkbox.checked = this.plugin.settings.llmSettings.useManualPrompting;
		checkbox.checked = this.plugin.settings.llmSettings.useManualPrompting;

		const label = manualPromptingSetting.createEl("label", {
			text: "Manual prompting"
		});
		label.setAttribute("for", "manual-prompting"); // Set 'for' attribute separately

		checkbox.onchange = (e) => {
			this.plugin.settings.llmSettings.useManualPrompting = (e.target as HTMLInputElement).checked;
			this.plugin.saveSettings();
		};

		// Confirm button
		const confirmBtn = llmContent.createEl("button", {
			cls: "btn primary",
			text: "Confirm"
		});

		confirmBtn.onclick = async () => {
			if (this.plugin.settings.llmSettings.useManualPrompting) {
				if (this.selectedNodes.size === 0) {
					new Notice('Please select at least one note first');
					return;
				}

				new LLMPromptModal(
					this.app,
					this.plugin,
					this.data,
					this.selectedNodes,
					this.tagManager
				).open();
			} else {
				new Notice('Manual prompting is disabled. Enable it to use this feature.');
			}
		};
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("graph-view-modal-grid");
		const graphView = contentEl.createDiv({ cls: "graph-view", attr: { id: "graphView" } });


		const tagsPanel = contentEl.createDiv({ cls: "tags-panel" });
		const tagsHeader = tagsPanel.createDiv({ cls: "panel-header" });
		tagsHeader.createEl("span", { text: "Browse tags" });
		const tagControls = tagsHeader.createDiv({ cls: "controls" });

		this.tagSearchInput = tagControls.createEl("input", {
			type: "text",
			cls: "search",
			placeholder: "Search tags...",
			attr: { "aria-label": "Search tags" }
		}) as HTMLInputElement;

		this.tagSearchInput.value = this.plugin.settings.tagSearchQuery || '';
		this.tagSearchInput.oninput = () => {
			this.plugin.settings.tagSearchQuery = this.tagSearchInput!.value;
			this.plugin.saveSettings();
			this.refreshTagList();
		};


		const addTagBtn = tagControls.createEl("button", {
			cls: "btn",
			text: "＋",
			attr: { title: "Add Tag" }
		});
		addTagBtn.onclick = () => this.showAddTagModal();

		const sortContainer = tagControls.createDiv({ cls: "sort-container" });

		const sortDropdown = sortContainer.createDiv({ cls: "sort-dropdown hidden" });

		const sortByName = sortDropdown.createEl("button", {
			text: "By Name",
			cls: this.plugin.settings.tagSortOrder === 'name' ? 'active' : ''
		});
		sortByName.onclick = () => {
			this.plugin.settings.tagSortOrder = 'name';
			this.plugin.saveSettings();
			this.refreshTagList();
		};

		const sortByCount = sortDropdown.createEl("button", {
			text: "By Count",
			cls: this.plugin.settings.tagSortOrder === 'count' ? 'active' : ''
		});
		sortByCount.onclick = () => {
			this.plugin.settings.tagSortOrder = 'count';
			this.plugin.saveSettings();
			this.refreshTagList();
		};

		const sortByRecent = sortDropdown.createEl("button", {
			text: "By Recent",
			cls: this.plugin.settings.tagSortOrder === 'recent' ? 'active' : ''
		});
		sortByRecent.onclick = () => {
			this.plugin.settings.tagSortOrder = 'recent';
			this.plugin.saveSettings();
			this.refreshTagList();
		};

		// Close dropdown when clicking elsewhere
		document.addEventListener('click', () => {
			sortDropdown.classList.add('hidden');
		});
		tagControls.createEl("button", { cls: "btn", text: "↕", attr: { title: "Sort" } });

		const tagList = tagsPanel.createEl("ul", { cls: "tag-list" });
		this.renderTagList(tagList);



		const llmPanel = contentEl.createDiv({ cls: "llm-panel" });
		this.renderLLMPanel(llmPanel);






		const vault = contentEl.createDiv({ cls: "vault-tree-container" });

		// browser
		const browser = vault.createDiv({ cls: "vault-browser" });
		/* real file tree */
		const fileTree = browser.createEl("ul", { cls: "file-tree" });

		this.fileTreeEl = fileTree;

		this.renderTree(this.treeRoot, fileTree);

		// actions footer
		const actions = vault.createDiv({ cls: "vault-actions" });

		const actionsLeft = actions.createDiv({ cls: "actions-left" });
		actionsLeft.createEl("button", { cls: "btn ghost", text: "Cancel" });

		const actionsRight = actions.createDiv({ cls: "actions-right" });
		actionsRight.createEl("button", { cls: "btn primary", text: "Confirm" });

		contentEl.createDiv({ cls: "resize-h resize-h-1" });
		contentEl.createDiv({ cls: "resize-v resize-v-1" });
		contentEl.createDiv({ cls: "resize-v resize-v-2" });

		this.enableResize(contentEl);
		setTimeout(() => {
			this.initializeGraph();
		}, 100);
		setTimeout(() => {
			this.refreshTagList();
		}, 100);

	}
	public refreshTagList() {
		const tagList = this.contentEl.querySelector('.tag-list');
		if (!tagList) return;

		const tagListEl = tagList as HTMLElement;
		tagListEl.innerHTML = '';
		// Get all tags from tag manager
		const allTags = Array.from(this.tagManager.getTags().values());

		// Filter by search query
		const searchQuery = this.tagSearchInput?.value.toLowerCase() || '';
		let filteredTags = allTags.filter(tag =>
			tag.name.toLowerCase().includes(searchQuery)
		);

		// Sort tags
		const sortOrder = this.plugin.settings.tagSortOrder || 'count';
		switch (sortOrder) {
			case 'name':
				filteredTags.sort((a, b) => a.name.localeCompare(b.name));
				break;
			case 'count':
				filteredTags.sort((a, b) => (b.count || 0) - (a.count || 0)); // Use count property
				break;
			case 'recent':
				filteredTags.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
				break;
		}
		// Highlight and bring to top tags that have selected files
		const selectedTags = new Set<string>();
		this.selectedNodes.forEach(filePath => {
			const fileTags = this.extractFileTags(filePath);
			fileTags.forEach(tag => selectedTags.add(tag));
		});

		// Sort: selected tags first, then others
		filteredTags.sort((a, b) => {
			const aSelected = selectedTags.has(a.name);
			const bSelected = selectedTags.has(b.name);
			if (aSelected && !bSelected) return -1;
			if (!aSelected && bSelected) return 1;
			return 0;
		});

		if (filteredTags.length === 0) {
			const emptyMsg = tagList.createEl('p', {
				cls: 'empty-message',
				text: searchQuery ? 'No tags match your search' : 'No tags found'
			});
			return;
		}

		// Render tags
		filteredTags.forEach(tag => {
			const li = tagList.createEl('li', {
				cls: `tag-item ${selectedTags.has(tag.name) ? 'selected-tag' : ''}`
			});

			// Tag color
			const tagColor = li.createDiv({ cls: `tag-color ${tag.color}` });
			tagColor.onclick = (e) => {
				e.stopPropagation();
				this.showColorPicker(tag.name, tag.color);
			};

			// Tag name
			const tagNameEl = li.createDiv({ cls: 'tag-name', text: `#${tag.name}` });

			// Tag count
			const tagCount = li.createDiv({
				cls: 'tag-count',
				text: `(${tag.count})`
			});

			// Selection indicator
			if (selectedTags.has(tag.name)) {
				const selectedIndicator = li.createDiv({ cls: 'selected-indicator' });
				selectedIndicator.innerHTML = '✓';
			}

			// Click handler
			li.onclick = () => {
				this.toggleTagSelection(tag.name);
			};
		});
	}
	onClose() {
		if (this.graphRenderer) {
			this.graphRenderer.destroy();
		}
	}
	private showAddTagModal() {
		// Simple modal to add a new tag
		const modal = new Modal(this.app);
		modal.titleEl.setText("Add New Tag");

		const content = modal.contentEl;
		content.createEl('p', { text: 'Enter tag name:' });

		const input = content.createEl('input', {
			type: 'text',
			placeholder: '#tagname'
		});

		const buttonContainer = content.createDiv({ cls: 'modal-button-container' });
		const confirmBtn = buttonContainer.createEl('button', { text: 'Add Tag', cls: 'mod-cta' });
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });

		confirmBtn.onclick = () => {
			const tagName = input.value.trim();
			if (tagName && tagName.startsWith('#')) {
				// Add the tag to your data structure
				console.log('Adding tag:', tagName);
				modal.close();
			}
		};

		cancelBtn.onclick = () => modal.close();

		modal.open();
	}
	private renderTagList(container: HTMLElement) {
		container.empty();

		if (!this.graphRenderer) {
			container.createEl('p', { text: 'No graph data available' });
			return;
		}

		// Get tags from TagManager instead of GraphRenderer
		const relevantTags = new Map<string, GraphTag>();
		const tagMap = this.tagManager.getTags();

		tagMap.forEach((tagData, tagName) => {
			// Check if any file with this tag is selected
			const hasSelectedFile = tagData.files.some(filePath =>
				this.selectedNodes.has(filePath)
			);

			if (hasSelectedFile) {
				relevantTags.set(tagName, {
					name: tagName,
					color: tagData.color,
					files: new Set(tagData.files)
				});
			}
		});

		console.log('Rendering tags:', {
			totalTags: tagMap.size,
			relevantTags: relevantTags.size,
			selectedNodes: this.selectedNodes.size
		});

		if (relevantTags.size === 0) {
			if (this.selectedNodes.size === 0) {
				container.createEl('p', { text: 'Select files to see their tags' });
			} else {
				container.createEl('p', { text: 'No tags found in selected files' });
			}
			return;
		}

		// Convert to array and sort by tag name
		const sortedTags = Array.from(relevantTags.entries())
			.sort(([a], [b]) => a.localeCompare(b));

		sortedTags.forEach(([tagName, tagData]) => {
			const li = container.createEl('li', { cls: 'tag-item' });

			// Get the actual color class from TagManager
			const tagInfo = this.tagManager.getTag(tagName);
			const colorClass = tagInfo ? tagInfo.color : tagData.color;

			// Tag color with click to change
			const tagColor = li.createDiv({ cls: `tag-color ${colorClass}` });
			tagColor.onclick = (e) => {
				e.stopPropagation();
				this.showColorPicker(tagName, colorClass);
			};

			// Tag name
			const tagNameEl = li.createDiv({ cls: 'tag-name', text: `#${tagName}` });

			// File count
			const fileCount = tagInfo ? tagInfo.files.filter(filePath =>
				this.selectedNodes.has(filePath)
			).length : 0;

			const tagCount = li.createDiv({ cls: 'tag-count', text: `(${fileCount})` });

			// Click handler for tag selection
			li.onclick = () => {
				this.toggleTagSelection(tagName);
			};
		});
	}


	private showColorPicker(tagName: string, currentColor: string) {
		const modal = new Modal(this.app);
		modal.titleEl.setText(`Choose color for #${tagName}`);

		const content = modal.contentEl;

		// Create color grid for quick selection
		content.createEl('p', { text: 'Quick colors:' });
		const colorGrid = content.createDiv({ cls: 'color-grid' });

		const colorOptions = [
			{ class: 'tag-color-1', hex: '#ff6b6b' },
			{ class: 'tag-color-2', hex: '#4ecdc4' },
			{ class: 'tag-color-3', hex: '#45b7d1' },
			{ class: 'tag-color-4', hex: '#96ceb4' },
			{ class: 'tag-color-5', hex: '#feca57' },
			{ class: 'tag-color-6', hex: '#ff9ff3' },
			{ class: 'tag-color-7', hex: '#54a0ff' },
			{ class: 'tag-color-8', hex: '#5f27cd' },
			{ class: 'tag-color-9', hex: '#00d2d3' },
			{ class: 'tag-color-10', hex: '#ff9f43' }
		];

		colorOptions.forEach(color => {
			const colorBtn = colorGrid.createDiv({
				cls: `color-option ${color.class} ${color.class === currentColor ? 'selected' : ''}`,
				title: color.hex
			});

			colorBtn.onclick = () => {
				this.updateTagColor(tagName, color.class);
				modal.close();
			};
		});

		// Hex color input
		content.createEl('p', { text: 'Custom hex color:' });
		const hexInputContainer = content.createDiv({ cls: 'hex-input-container' });
		const hexInput = hexInputContainer.createEl('input', {
			type: 'text',
			placeholder: '#RRGGBB',
			value: this.getHexColor(currentColor) || '#ff6b6b'
		});

		const hexPreview = hexInputContainer.createDiv({ cls: 'hex-preview' });
		hexPreview.style.backgroundColor = hexInput.value;

		hexInput.oninput = () => {
			const value = hexInput.value;
			// Validate hex color
			if (/^#[0-9A-F]{6}$/i.test(value)) {
				hexPreview.style.backgroundColor = value;
			}
		};

		// Custom color button
		const customColorBtn = content.createEl('button', {
			text: 'Use Custom Color',
			cls: 'mod-cta'
		});

		customColorBtn.onclick = () => {
			const hexValue = hexInput.value;
			if (/^#[0-9A-F]{6}$/i.test(hexValue)) {
				// Create a custom color class
				const customColorClass = `custom-${tagName.replace(/#/g, '')}`;

				// Update the tag with custom hex color
				this.updateTagColorWithHex(tagName, hexValue, customColorClass);
				modal.close();
			} else {
				new Notice('Invalid hex color. Use format #RRGGBB');
			}
		};

		modal.open();
	}

	private updateTagColorWithHex(tagName: string, hexColor: string, colorClass: string) {
		if (this.graphRenderer) {
			// First, update the tag in TagManager with the new color class
			this.tagManager.updateTagColor(tagName, colorClass);

			// Then update the graph renderer
			this.graphRenderer.updateTagColor(tagName, colorClass);

			// Store the hex color in settings
			this.plugin.settings.tagColors = this.plugin.settings.tagColors || {};
			this.plugin.settings.tagColors[tagName] = hexColor;

			// Also store the mapping between color class and hex
			this.plugin.settings.tagColors[`${colorClass}_hex`] = hexColor;

			this.plugin.saveSettings();

			// Add custom CSS for this color
			this.addCustomColorCSS(colorClass, hexColor);

			// Force refresh of tag list and graph
			this.refreshTagList();
			this.refreshGraph();
		}
	}

	private addCustomColorCSS(className: string, hexColor: string) {
		// Create or update a style element for custom colors
		let styleEl = document.getElementById('custom-tag-colors');
		if (!styleEl) {
			styleEl = document.createElement('style');
			styleEl.id = 'custom-tag-colors';
			document.head.appendChild(styleEl);
		}

		// Add or update the CSS rule
		const cssText = `
			.tag-color.${className} {
				background-color: ${hexColor} !important;
			}
			.graph-node.${className} {
				fill: ${hexColor} !important;
			}
		`;

		styleEl.textContent = cssText;
	}

	private updateTagColor(tagName: string, colorClass: string) {
		if (this.graphRenderer) {
			// Update the tag color in graph renderer
			this.graphRenderer.updateTagColor(tagName, colorClass);

			// Also update the tag color in TagManager
			this.tagManager.updateTagColor(tagName, colorClass);

			// Save to plugin settings
			this.plugin.settings.tagColors = this.plugin.settings.tagColors || {};
			this.plugin.settings.tagColors[tagName] = colorClass;
			this.plugin.saveSettings();

			this.refreshTagList();
		}
	}
	private toggleTagSelection(tagName: string) {
		// Implement tag-based filtering if needed
		console.log('Tag toggled:', tagName);
		this.refreshTagList();
	}

	private isTagSelected(tagName: string): boolean {
		// Implement your tag selection logic here
		return false;
	}

	private getHexColor(colorClass: string): string {
		const colorMap: { [key: string]: string } = {
			'tag-color-1': '#ff6b6b',
			'tag-color-2': '#4ecdc4',
			'tag-color-3': '#45b7d1',
			'tag-color-4': '#96ceb4',
			'tag-color-5': '#feca57',
			'tag-color-6': '#ff9ff3',
			'tag-color-7': '#54a0ff',
			'tag-color-8': '#5f27cd',
			'tag-color-9': '#00d2d3',
			'tag-color-10': '#ff9f43',
			'untagged-group-1': '#8a8a8a',
			'untagged-group-2': '#7c7c7c',
			'untagged-group-3': '#6e6e6e',
			'untagged-group-4': '#606060',
			'untagged-group-5': '#525252'
		};

		// Check if this is a custom color stored in settings
		if (this.plugin.settings.tagColors[colorClass]) {
			return this.plugin.settings.tagColors[colorClass];
		}

		// Check if there's a hex mapping for this color class
		const hexKey = `${colorClass}_hex`;
		if (this.plugin.settings.tagColors[hexKey]) {
			return this.plugin.settings.tagColors[hexKey];
		}

		return colorMap[colorClass] || '#69b3a2';
	}
	private addCustomTagColor(tagName: string, hexColor: string): string {
		const colorClass = `custom-${tagName}`;
		// Store in plugin settings
		this.plugin.settings.tagColors[tagName] = hexColor;
		this.plugin.saveSettings();
		return colorClass;
	}


}


class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Graph View Settings' });

		// Graph settings
		new Setting(containerEl)
			.setName('Show Tag Connections')
			.setDesc('Display connections between files with shared tags')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.graphSettings.showTagConnections)
				.onChange(async (value) => {
					this.plugin.settings.graphSettings.showTagConnections = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default Link Distance')
			.setDesc('Distance between connected nodes')
			.addSlider(slider => slider
				.setLimits(50, 300, 10)
				.setValue(this.plugin.settings.graphSettings.linkDistance)
				.onChange(async (value) => {
					this.plugin.settings.graphSettings.linkDistance = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button => button
				.setIcon('reset')
				.setTooltip('Reset to default')
				.onClick(async () => {
					this.plugin.settings.graphSettings.linkDistance = DEFAULT_SETTINGS.graphSettings.linkDistance;
					await this.plugin.saveSettings();
					this.display();
				}));

		// Tag settings
		containerEl.createEl('h3', { text: 'Tag Settings' });

		new Setting(containerEl)
			.setName('Default Tag Sort Order')
			.setDesc('How tags are sorted by default')
			.addDropdown(dropdown => dropdown
				.addOption('name', 'By Name')
				.addOption('count', 'By Count')
				.addOption('recent', 'By Recent')
				.setValue(this.plugin.settings.tagSortOrder)
				.onChange(async (value) => {
					this.plugin.settings.tagSortOrder = value as any;
					await this.plugin.saveSettings();
				}));

		// LLM settings placeholder
		containerEl.createEl('h3', { text: 'LLM Integration' });

		new Setting(containerEl)
			.setName('Manual Prompting')
			.setDesc('Enable manual prompting interface for LLM analysis')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.llmSettings.useManualPrompting)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.useManualPrompting = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your LLM API key (e.g., OpenAI, Anthropic)')
			.addText(text => text
				.setPlaceholder('sk-...')
				.setValue(this.plugin.settings.llmSettings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model to use for analysis')
			.addText(text => text
				.setPlaceholder('gpt-3.5-turbo')
				.setValue(this.plugin.settings.llmSettings.model)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.model = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Creativity level (0-1)')
			.addSlider(slider => slider
				.setLimits(0, 1, 0.1)
				.setValue(this.plugin.settings.llmSettings.temperature)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.temperature = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max Tokens')
			.setDesc('Maximum response length')
			.addText(text => text
				.setPlaceholder('1000')
				.setValue(this.plugin.settings.llmSettings.maxTokens.toString())
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.maxTokens = parseInt(value) || 1000;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('System Prompt')
			.setDesc('Base prompt for LLM analysis')
			.addTextArea(text => text
				.setPlaceholder('You are an expert at analyzing notes...')
				.setValue(this.plugin.settings.llmSettings.systemPrompt)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.systemPrompt = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Analyze for New Tags')
			.setDesc('Let LLM suggest new tags based on content')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.llmSettings.analyzeForNewTags)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.analyzeForNewTags = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Fit to Existing Tags')
			.setDesc('Let LLM assign existing tags to notes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.llmSettings.fitToExistingTags)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.fitToExistingTags = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Generate Connections')
			.setDesc('Let LLM suggest connections between notes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.llmSettings.generateConnections)
				.onChange(async (value) => {
					this.plugin.settings.llmSettings.generateConnections = value;
					await this.plugin.saveSettings();
				}));

	}
}

class TagManager {
	private plugin: MyPlugin;
	private tags: Map<string, TagData> = new Map();

	constructor(plugin: MyPlugin) {
		this.plugin = plugin;
	}

	public async initialize(data: Record<string, FileSummary>) {
		await this.loadTags();
		this.extractAndUpdateTags(data);
	}

	public async extractAndUpdateTags(data: Record<string, FileSummary>) {
		const newTags = new Map<string, TagData>();
		const now = Date.now();

		Object.entries(data).forEach(([path, fileSummary]) => {
			const content = fileSummary.content;
			const lines = content.split('\n');

			for (const line of lines) {
				if (line.trim().startsWith('```') ||
					line.includes('`') && line.split('`').length % 2 === 0) {
					continue;
				}

				const tagMatches = line.matchAll(/(?:^|\s)#([a-zA-Zа-яА-ЯёЁ][a-zA-Zа-яА-ЯёЁ0-9_-]*)/g);
				for (const match of tagMatches) {
					const tagName = match[1].toLowerCase();
					if (tagName && tagName.length > 0) {
						const falsePositives = ['include', 'define', 'ifndef', 'ifdef', 'endif', 'pragma'];
						if (falsePositives.includes(tagName)) continue;

						if (!newTags.has(tagName)) {
							// Preserve existing tag data or create new
							const existingTag = this.tags.get(tagName) || this.plugin.settings.tags[tagName];
							newTags.set(tagName, {
								name: tagName,
								color: existingTag?.color || `tag-color-${(newTags.size % 10) + 1}`,
								files: existingTag?.files || [],
								count: existingTag?.files?.length || 0, // Calculate count from files array
								lastUsed: existingTag?.lastUsed || now
							});
						}

						const tagData = newTags.get(tagName)!;
						if (!tagData.files.includes(path)) {
							tagData.files.push(path);
							tagData.count = tagData.files.length; // Update count based on files array
							tagData.lastUsed = now;
						}
					}
				}
			}
		});

		this.tags = newTags;
		await this.saveTags();
	}


	public getTags(): Map<string, TagData> {
		return this.tags;
	}

	public getTag(tagName: string): TagData | undefined {
		return this.tags.get(tagName);
	}

	public async updateTagColor(tagName: string, color: string) {
		const tag = this.tags.get(tagName);
		if (tag) {
			tag.color = color;
			await this.saveTags();
		}
	}

	public async addTag(tagName: string, color?: string) {
		if (!this.tags.has(tagName)) {
			this.tags.set(tagName, {
				name: tagName,
				color: color || `tag-color-${(this.tags.size % 10) + 1}`,
				files: [],
				count: 0,
				lastUsed: Date.now()
			});
			await this.saveTags();
		}
	}

	public async removeTag(tagName: string) {
		this.tags.delete(tagName);
		await this.saveTags();
	}

	private async loadTags() {
		Object.entries(this.plugin.settings.tags || {}).forEach(([tagName, data]) => {
			this.tags.set(tagName, {
				name: tagName,
				color: data.color,
				files: data.files || [],
				count: data.count || data.files?.length || 0, // Handle missing count
				lastUsed: data.lastUsed || Date.now()
			});
		});
	}

	private async saveTags() {
		const tagsRecord: Record<string, any> = {};
		this.tags.forEach((tag, tagName) => {
			tagsRecord[tagName] = {
				color: tag.color,
				files: tag.files,
				count: tag.count, // Save count
				lastUsed: tag.lastUsed
			};
		});

		this.plugin.settings.tags = tagsRecord;
		await this.plugin.saveSettings();
	}
}

interface TagData {
	name: string;
	color: string;
	files: string[];
	count: number; // Add this line
	lastUsed: number;
}