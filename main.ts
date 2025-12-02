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
	tagColors: Record<string, string>; // Store custom tag colors
	expandedTags: string[]; // Store expanded/collapsed state

}


const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	tagColors: {},
	expandedTags: []
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
	// In your main plugin class
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("dot-network", "Custom Graph", async () => {
			const data = await parseVault(this.app.vault);
			new GraphViewModal(this.app,this, data).open();
		});


		this.addCommand({
			id: "open-custom-graph",
			name: "Open custom graph",
			callback: async () => {
				const data = await parseVault(this.app.vault);
				new GraphViewModal(this.app,this, data).open();
			}
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	
}
interface TreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: TreeNode[];
}

import { GraphRenderer, GraphSettings, GraphNode } from './GraphRenderer';

class GraphViewModal extends Modal {
	data: Record<string, FileSummary>;
	selectedNodes: Set<string> = new Set(); 
	treeRoot: TreeNode;
	fileTreeEl: HTMLElement | null = null;
	expanded = new Set<string>();

	private showSettings = false;

	private plugin: MyPlugin;
	// Graph properties
	private graphRenderer: GraphRenderer | null = null;
	private graphContainer: HTMLElement | null = null;

	constructor(app: App,plugin: MyPlugin, data: Record<string, FileSummary>) {
		super(app);
		this.plugin = plugin;
		this.data = data;
		this.treeRoot = buildVaultTree(app);
		this.modalEl.addClass("graph-view-modal");
		this.expanded.add("");
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
				const row = li.createDiv({ cls: "file-row", text: child.name });

				if (this.selectedNodes.has(child.path)) row.addClass("selected");

				// Update the file click handler in renderTree method:

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
				};
			}
		}
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
	}

	private initializeGraph() {
        this.graphContainer = this.contentEl.querySelector('.graph-view') as HTMLElement;
        if (!this.graphContainer) {
            console.error('Graph container not found');
            return;
        }

        // Ensure the graph container has proper dimensions
        this.graphContainer.style.width = '100%';
        this.graphContainer.style.height = '100%';
        this.graphContainer.style.minHeight = '400px';

        console.log('Initializing graph with data:', Object.keys(this.data).length, 'files');
        console.log('Initially selected files:', Array.from(this.selectedNodes));

        // Create graph controls
        this.createGraphControls(this.graphContainer);

        // Create settings panel (hidden by default)
        this.createSettingsPanel(this.graphContainer);

        // Initialize graph renderer
        this.graphRenderer = new GraphRenderer(
            this.graphContainer,
            this.data,
            this.selectedNodes,
            (node: GraphNode) => this.handleNodeClick(node)
        );

        // Force an initial refresh
        setTimeout(() => {
            this.refreshGraph();
        }, 500);
    }

	private createGraphControls(container: HTMLElement) {
        const controls = container.createDiv({ cls: 'graph-controls' });

        const resetZoom = controls.createEl('button', { text: 'Reset Zoom' });
        resetZoom.onclick = () => {
            this.graphRenderer?.centerGraph();
        };

        const centerGraph = controls.createEl('button', { text: 'Center' });
        centerGraph.onclick = () => {
            this.graphRenderer?.centerGraph();
        };

        const refreshGraph = controls.createEl('button', { text: 'Refresh' });
        refreshGraph.onclick = () => {
            this.refreshGraph();
        };

        // Add settings toggle button
        const settingsToggle = controls.createEl('button', { text: '⚙️ Settings' });
        settingsToggle.onclick = () => {
            this.toggleSettings();
        };
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
        const settingsPanel = container.createDiv({ cls: 'graph-settings hidden' }); // Start hidden

        settingsPanel.createEl('h4', { text: 'Graph Settings' });

        // Wait for graphRenderer to be initialized before creating sliders
        if (this.graphRenderer) {
            this.createSliders(settingsPanel);
        } else {
            // Delay slider creation until graphRenderer is ready
            setTimeout(() => this.createSliders(settingsPanel), 100);
        }
    }
	private createSliders(settingsPanel: HTMLElement) {
        if (!this.graphRenderer) return;

        // Clear any existing sliders
        const existingSliders = settingsPanel.querySelectorAll('.setting-item');
        existingSliders.forEach(el => el.remove());

        // Create sliders with proper initial values
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

        // Set initial state from graph renderer settings
        tagToggle.checked = this.graphRenderer.settings.showTagConnections;

        tagToggle.onchange = (e) => {
            if (this.graphRenderer) {
                this.graphRenderer.settings.showTagConnections = (e.target as HTMLInputElement).checked;
                this.refreshGraph();
            }
        };
    }

	private createSlider(container: HTMLElement, label: string, key: string, min: number, max: number, step: number) {
        if (!this.graphRenderer) return;

        const settingItem = container.createDiv({ cls: 'setting-item' });

        const labelEl = settingItem.createEl('label', { text: label });
        const valueDisplay = settingItem.createDiv({ cls: 'value-display' });

        // Get the actual current value from graph renderer settings
        const currentValue = (this.graphRenderer.settings as any)[key];
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
            if (this.graphRenderer) {
                // Update the setting
                (this.graphRenderer.settings as any)[key] = newValue;
                valueDisplay.textContent = newValue.toFixed(2);
                this.graphRenderer.updateSimulation();
            }
        };

        // Also update on change for better responsiveness
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

	private refreshGraph() {
        console.log('Refreshing graph with selected files:', Array.from(this.selectedNodes));
        if (this.graphRenderer) {
            // Re-parse the vault data to get updated tags
            parseVault(this.app.vault).then(newData => {
                this.data = newData;
                this.graphRenderer!.updateData(newData);
                this.graphRenderer!.updateSelection(this.selectedNodes);
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

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("graph-view-modal-grid");
		const graphView = contentEl.createDiv({ cls: "graph-view", attr: { id: "graphView" } });

		const tagsPanel = contentEl.createDiv({ cls: "tags-panel" });

		const tagsHeader = tagsPanel.createDiv({ cls: "panel-header" });
		tagsHeader.createEl("span", { text: "Browse tags" });

		const tagControls = tagsHeader.createDiv({ cls: "controls" });

		tagControls.createEl("input", {
			type: "text",
			cls: "search",
			placeholder: "Search tags...",
			attr: { "aria-label": "Search tags" }
		});

		const addTagBtn = tagControls.createEl("button", { cls: "btn", text: "＋", attr: { title: "Add Tag" } });
		addTagBtn.onclick = () => this.showAddTagModal();

		tagControls.createEl("button", { cls: "btn", text: "↕", attr: { title: "Sort" } });

		const tagList = tagsPanel.createEl("ul", { cls: "tag-list" });
		this.renderTagList(tagList);




		const llmPanel = contentEl.createDiv({ cls: "llm-panel" });
		const llmHeader = llmPanel.createDiv({ cls: "panel-header" });
		llmHeader.createEl("span", { text: "LLM settings" });

		llmPanel.createDiv({ cls: "llm-content" }); // empty placeholder

		const vault = contentEl.createDiv({ cls: "vault-tree-container" });

		// header
		const vHeader = vault.createDiv({ cls: "vault-header" });
		vHeader.createDiv({ cls: "vault-title", text: "Browse tree" });

		const vControls = vHeader.createDiv({ cls: "vault-controls" });

		vControls.createEl("input", {
			type: "text",
			cls: "search",
			placeholder: "Search files...",
			attr: { "aria-label": "Search files" }
		});

		vControls.createEl("button", { cls: "btn", text: "▤", attr: { title: "Filter" } });
		vControls.createEl("button", { cls: "btn", text: "↕", attr: { title: "Sort" } });

		// browser
		const browser = vault.createDiv({ cls: "vault-browser" });
		/* real file tree */
		const fileTree = browser.createEl("ul", { cls: "file-tree" });

		this.renderTree(this.treeRoot, fileTree);

		// actions footer
		const actions = vault.createDiv({ cls: "vault-actions" });

		const actionsLeft = actions.createDiv({ cls: "actions-left" });
		actionsLeft.createEl("button", { cls: "btn ghost", text: "Cancel" });

		const actionsRight = actions.createDiv({ cls: "actions-right" });
		actionsRight.createEl("button", { cls: "btn primary", text: "Confirm" });
		actionsRight.createEl("button", { cls: "btn", text: "Open" });

		contentEl.createDiv({ cls: "resize-h resize-h-1" });
		contentEl.createDiv({ cls: "resize-v resize-v-1" });
		contentEl.createDiv({ cls: "resize-v resize-v-2" });

		this.enableResize(contentEl);
		setTimeout(() => {
			this.initializeGraph();
		}, 100);

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
    
        // Get tags relevant to currently selected nodes
        const relevantTags = this.graphRenderer.getTagsForSelectedNodes();
        
        console.log('Rendering tags:', {
            totalTags: this.graphRenderer.getTags().size,
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
            
            // Apply custom color from settings if available
            const customColor = this.plugin.settings.tagColors[tagName];
            const finalColorClass = customColor || tagData.color;
            
            // Tag color with click to change
            const tagColor = li.createDiv({ cls: `tag-color ${finalColorClass}` });
            tagColor.onclick = (e) => {
                e.stopPropagation();
                this.showColorPicker(tagName, finalColorClass);
            };
            
            // Tag name
            const tagNameEl = li.createDiv({ cls: 'tag-name', text: `#${tagName}` });
            
            // File count
            const fileCount = Array.from(tagData.files).filter(filePath => 
                this.selectedNodes.has(filePath)
            ).length;
            const tagCount = li.createDiv({ cls: 'tag-count', text: `(${fileCount})` });
            
            // Selection state
            if (this.isTagSelected(tagName)) {
                li.addClass('selected');
            }
            
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
		content.createEl('p', { text: 'Select a color:' });
		
		const colorGrid = content.createDiv({ cls: 'color-grid' });
		
		// Predefined color options
		const colorOptions = [
			'tag-color-1', 'tag-color-2', 'tag-color-3', 'tag-color-4', 'tag-color-5',
			'tag-color-6', 'tag-color-7', 'tag-color-8', 'tag-color-9', 'tag-color-10'
		];
		
		colorOptions.forEach(colorClass => {
			const colorBtn = colorGrid.createDiv({ 
				cls: `color-option ${colorClass} ${colorClass === currentColor ? 'selected' : ''}`
			});
			
			colorBtn.onclick = () => {
				this.updateTagColor(tagName, colorClass);
				modal.close();
			};
		});
		
		modal.open();
	}
	
	private updateTagColor(tagName: string, colorClass: string) {
		if (this.graphRenderer) {
			// Update the tag color in graph renderer
			this.graphRenderer.updateTagColor(tagName, colorClass);
			
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
	
	private refreshTagList() {
		const tagList = this.contentEl.querySelector('.tag-list');
		if (tagList) {
			this.renderTagList(tagList as HTMLElement);
		}
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
			'tag-color-10': '#ff9f43'
		};
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

		new Setting(containerEl)
			.setName("Setting")
			.addText(text =>
				text.setValue(this.plugin.settings.mySetting).onChange(async v => {
					this.plugin.settings.mySetting = v;
					// await this.plugin.settings();
				})
			);
	}
}
