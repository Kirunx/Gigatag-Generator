// GraphRenderer.ts
import * as d3 from "d3";

export interface GraphNode extends d3.SimulationNodeDatum {
    id: string;
    name: string;
    path: string;
    radius: number;
    isSelected?: boolean;
    color?: string;
}

export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
    source: GraphNode;
    target: GraphNode;
    type?: string;
    tag?: string;
}

export interface GraphTag {
    name: string;
    color: string;
    files: Set<string>;
}

export interface GraphSettings {
    gravity: number;
    repelling: number;
    linkDistance: number;
    charge: number;
    centerStrength: number;
    showTagConnections: boolean;
}

export interface FileSummary {
    file: string;
    content: string;
    links: string[];
}

export class GraphRenderer {
    private graphSvg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private graphG: d3.Selection<SVGGElement, unknown, null, undefined>;
    private simulation: d3.Simulation<GraphNode, undefined>;
    private nodes: GraphNode[] = [];
    private links: GraphLink[] = [];
    private nodeElements: d3.Selection<SVGCircleElement, GraphNode, SVGGElement, unknown>;
    private linkElements: d3.Selection<SVGLineElement, GraphLink, SVGGElement, unknown>;
    private labelElements: d3.Selection<SVGTextElement, GraphNode, SVGGElement, unknown>;
    private tooltip: HTMLElement;

    // Remove the duplicate settings declaration and keep only this one:
    public settings: GraphSettings = {
        gravity: 0.1,
        repelling: 100,
        linkDistance: 100,
        charge: -30,
        centerStrength: 0.1,
        showTagConnections: false
    };

    private selectedNodes: Set<string> = new Set();
    private allData: Record<string, FileSummary> = {};
    private onNodeClick?: (node: GraphNode) => void;

    // Add these new properties
    private tags: Map<string, GraphTag> = new Map();
    private showSettings = true;
    private tagColorIndex = 1;
    private randomColorIndex = 1;
    constructor(
        private container: HTMLElement,
        data: Record<string, FileSummary>,
        selectedFiles: Set<string>,
        tags: Map<string, GraphTag>,
        settings?: Partial<GraphSettings>, // Add optional settings parameter
        onNodeClick?: (node: GraphNode) => void
    ) {
        this.allData = data;
        this.selectedNodes = selectedFiles;
        this.tags = tags;
        this.onNodeClick = onNodeClick;
        
        // Apply custom settings if provided
        if (settings) {
            this.settings = { ...this.settings, ...settings };
        }
        
        this.initializeGraph();
    }

    public updateSelection(selectedFiles: Set<string>) {
        this.selectedNodes = selectedFiles;
        this.generateGraphData(); // This will use the latest tags
        this.updateGraphElements();
        this.restartSimulation();
    }
    public updateTags(tags: Map<string, GraphTag>) {
        this.tags = tags;
        this.generateGraphData();
        this.updateGraphElements();
        this.restartSimulation();
    }
    public updateData(data: Record<string, FileSummary>) {
        this.allData = data;
        this.generateGraphData();
        this.updateGraphElements();
        this.restartSimulation();
    }

    private initializeGraph() {
        // Create tooltip
        this.tooltip = this.container.createDiv({ cls: 'graph-tooltip' });

        // Get container dimensions
        const containerRect = this.container.getBoundingClientRect();

        // Create SVG with zoom behavior
        this.graphSvg = d3.select(this.container)
            .append('svg')
            .attr('class', 'graph-svg')
            .attr('width', containerRect.width)
            .attr('height', containerRect.height)
            .call(d3.zoom<SVGSVGElement, unknown>()
                .scaleExtent([0.1, 4])
                .on('zoom', (event) => {
                    this.graphG.attr('transform', event.transform);
                })
            );

        this.graphG = this.graphSvg.append('g');

        console.log(`Graph initialized with ${this.tags.size} tags`);
        // Generate initial graph data
        this.generateGraphData();

        // Create graph elements first
        this.createGraphElements();

        // Then initialize simulation with the elements
        this.initializeSimulation();

        // Update graph on resize
        this.setupResizeObserver();
    }


    public getTagsForSelectedNodes(): Map<string, GraphTag> {
        const relevantTags = new Map<string, GraphTag>();

        this.tags.forEach((tag, tagName) => {
            // Check if any file with this tag is selected
            const hasSelectedFile = Array.from(tag.files).some(filePath =>
                this.selectedNodes.has(filePath)
            );

            if (hasSelectedFile) {
                relevantTags.set(tagName, tag);
            }
        });

        return relevantTags;
    }

    public getTags(): Map<string, GraphTag> {
        return this.tags;
    }
    // Add method to update tag colors
    public updateTagColor(tagName: string, colorClass: string) {
        const tag = this.tags.get(tagName);
        if (tag) {
            tag.color = colorClass;
            this.generateGraphData(); // Regenerate with new colors
            this.updateGraphElements();
            this.restartSimulation();
        }
    }

    private generateGraphData() {
        // Clear existing data
        this.nodes = [];
        this.links = [];
        this.randomColorIndex = 1;

        // If no files are selected, show nothing
        if (this.selectedNodes.size === 0) {
            console.log('No files selected for graph');
            return;
        }

        const nodeMap = new Map<string, GraphNode>();
        const fileTags = new Map<string, Set<string>>();
        const tagGroups = new Map<string, string[]>();
        const untaggedFiles: string[] = [];

        // First pass: collect tags for selected files
        Array.from(this.selectedNodes).forEach(path => {
            const fileSummary = this.allData[path];
            if (!fileSummary) return;

            // Get tags for this file from the tag manager
            const tags = new Set<string>();

            // Check which tags include this file from our tag map
            this.tags.forEach((tag, tagName) => {
                if (tag.files.has(path)) {
                    tags.add(tagName);

                    if (!tagGroups.has(tagName)) {
                        tagGroups.set(tagName, []);
                    }
                    tagGroups.get(tagName)!.push(path);
                }
            });

            fileTags.set(path, tags);

            if (tags.size === 0) {
                untaggedFiles.push(path);
            }
        });

        const untaggedGroups = this.createUntaggedGroups(untaggedFiles);

        // Create nodes with proper colors
        Array.from(this.selectedNodes).forEach(path => {
            const fileSummary = this.allData[path];
            if (!fileSummary) return;

            // Determine node color
            let nodeColor = '';
            const tags = fileTags.get(path) || new Set();

            if (tags.size > 0) {
                // Use color of the most common tag among selected files
                const sortedTags = Array.from(tags).sort((a, b) => {
                    const aCount = tagGroups.get(a)?.length || 0;
                    const bCount = tagGroups.get(b)?.length || 0;
                    return bCount - aCount;
                });

                if (sortedTags.length > 0) {
                    const primaryTag = this.tags.get(sortedTags[0]);
                    nodeColor = primaryTag ? primaryTag.color : `untagged-group-1`;
                } else {
                    nodeColor = `untagged-group-1`;
                }
            } else {
                // Check which untagged group this file belongs to
                let groupFound = false;
                untaggedGroups.forEach((files, groupId) => {
                    if (files.includes(path)) {
                        nodeColor = `untagged-group-${groupId}`;
                        groupFound = true;
                    }
                });
                if (!groupFound) {
                    nodeColor = `untagged-group-1`;
                }
            }

            const node: GraphNode = {
                id: fileSummary.file,
                name: fileSummary.file,
                path: path,
                radius: 12, // Increased radius for better visibility
                isSelected: true,
                color: nodeColor
            };
            this.nodes.push(node);
            nodeMap.set(fileSummary.file, node);
            nodeMap.set(path, node);
        });

        console.log(`Created ${this.nodes.length} nodes: ${tagGroups.size} tagged groups, ${untaggedGroups.size} untagged groups`);

        // Create links
        Array.from(this.selectedNodes).forEach(path => {
            const fileSummary = this.allData[path];
            if (!fileSummary) return;

            const sourceNode = nodeMap.get(fileSummary.file) || nodeMap.get(path);
            if (!sourceNode) return;

            // Regular wiki links
            fileSummary.links.forEach(link => {
                const normalizedLink = link.replace(/\.md$/, '');
                const targetEntry = Object.entries(this.allData).find(([targetPath, targetFile]) => {
                    return targetFile.file === normalizedLink ||
                        targetPath === normalizedLink ||
                        targetPath.replace(/\.md$/, '') === normalizedLink;
                });

                if (targetEntry) {
                    const [targetPath, targetFile] = targetEntry;
                    if (this.selectedNodes.has(targetPath)) {
                        const targetNode = nodeMap.get(targetFile.file) || nodeMap.get(targetPath);
                        if (targetNode && sourceNode.id !== targetNode.id) {
                            const linkExists = this.links.some(l =>
                                (l.source.id === sourceNode.id && l.target.id === targetNode.id) ||
                                (l.source.id === targetNode.id && l.target.id === sourceNode.id)
                            );

                            if (!linkExists) {
                                this.links.push({
                                    source: sourceNode,
                                    target: targetNode,
                                    type: 'wiki-link'
                                });
                            }
                        }
                    }
                }
            });

            // Tag-based connections (if enabled)
            if (this.settings.showTagConnections) {
                const tags = fileTags.get(path) || new Set();
                tags.forEach(tag => {
                    const tagData = this.tags.get(tag);
                    if (tagData) {
                        tagData.files.forEach(targetPath => {
                            if (targetPath !== path && this.selectedNodes.has(targetPath)) {
                                const targetNode = nodeMap.get(targetPath);
                                if (targetNode && sourceNode.id !== targetNode.id) {
                                    const linkExists = this.links.some(l =>
                                        (l.source.id === sourceNode.id && l.target.id === targetNode.id) ||
                                        (l.source.id === targetNode.id && l.target.id === sourceNode.id)
                                    );

                                    if (!linkExists) {
                                        this.links.push({
                                            source: sourceNode,
                                            target: targetNode,
                                            type: 'tag-link',
                                            tag: tag
                                        });
                                    }
                                }
                            }
                        });
                    }
                });
            }
        });

        console.log(`Generated graph with ${this.nodes.length} nodes and ${this.links.length} links`);
    }

    private createUntaggedGroups(untaggedFiles: string[]): Map<number, string[]> {
        const groups = new Map<number, string[]>();
        const groupSize = 3; // Group untagged files in sets of 3

        for (let i = 0; i < untaggedFiles.length; i++) {
            const groupId = Math.floor(i / groupSize) + 1;
            if (!groups.has(groupId)) {
                groups.set(groupId, []);
            }
            groups.get(groupId)!.push(untaggedFiles[i]);
        }

        return groups;
    }

    private initializeSimulation() {
        // Stop existing simulation if it exists
        if (this.simulation) {
            this.simulation.stop();
        }

        const containerRect = this.container.getBoundingClientRect();

        console.log('Initializing simulation with:', {
            nodes: this.nodes.length,
            links: this.links.length,
            container: { width: containerRect.width, height: containerRect.height },
            settings: this.settings
        });

        // Create the simulation with proper configuration
        this.simulation = d3.forceSimulation<GraphNode>(this.nodes)
            .force("link", d3.forceLink<GraphNode, GraphLink>(this.links)
                .id(d => d.id)
                .distance(this.settings.linkDistance)
            )
            .force("charge", d3.forceManyBody<GraphNode>()
                .strength(d => this.settings.charge * (this.settings.repelling / 100))
                .distanceMin(10)
                .distanceMax(200)
            )
            .force("center", d3.forceCenter(containerRect.width / 2, containerRect.height / 2))
            .force("x", d3.forceX(containerRect.width / 2).strength(this.settings.centerStrength))
            .force("y", d3.forceY(containerRect.height / 2).strength(this.settings.gravity))
            .force("collision", d3.forceCollide<GraphNode>()
                .radius(d => d.radius + 5)
                .strength(0.5)
            )
            .alphaDecay(0.1)
            .velocityDecay(0.6)
            .alphaMin(0.001)
            .alpha(0.5)
            .on("tick", () => {
                this.ticked();
            });

        console.log('Simulation created:', this.simulation);

        // Force the simulation to run for a bit
        this.simulation.restart();
    }



    private createGraphElements() {
        // Remove existing elements
        this.graphG.selectAll('*').remove();

        // Create links FIRST (so they appear behind nodes)
        this.linkElements = this.graphG.append('g')
            .attr('class', 'links-container')
            .selectAll('line')
            .data(this.links)
            .enter()
            .append('line')
            .attr('class', (d: GraphLink) => `graph-link ${d.type}`)
            .style('stroke', (d: GraphLink) => {
                if (d.type === 'tag-link' && d.tag) {
                    const tag = this.tags.get(d.tag);
                    return tag ? this.getTagColor(tag.color) : '#999';
                }
                return '#999'; // Default color for wiki links
            })
            .style('stroke-width', (d: GraphLink) => d.type === 'tag-link' ? 1.5 : 2)
            .style('stroke-dasharray', (d: GraphLink) => d.type === 'tag-link' ? '5,5' : 'none')
            .style('stroke-opacity', 0.6);

        // Create nodes AFTER links (so they appear on top)
        this.nodeElements = this.graphG.append('g')
            .attr('class', 'nodes-container')
            .selectAll('circle')
            .data(this.nodes)
            .enter()
            .append('circle')
            .attr('class', (d: GraphNode) => `graph-node ${d.color}`)
            .attr('r', (d: GraphNode) => d.radius)
            // REMOVE this line: .style('fill', (d: GraphNode) => this.getNodeColor(d.color || ''))
            .style('cursor', 'pointer')
            .style('stroke', '#333')
            .style('stroke-width', 2)
            .call(this.createDragBehavior())
            .on('mouseover', (event, d) => this.showTooltip(event, d))
            .on('mouseout', () => this.hideTooltip());

        // Create labels LAST (so they appear on top of everything)
        this.labelElements = this.graphG.append('g')
            .attr('class', 'labels-container')
            .selectAll('text')
            .data(this.nodes)
            .enter()
            .append('text')
            .attr('class', 'graph-label')
            .text((d: GraphNode) => d.name)
            .attr('text-anchor', 'middle')
            .attr('dy', -15)
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .style('fill', '#333')
            .style('font-weight', 'bold')
            .style('text-shadow', '1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white');

        console.log('Graph elements created');
    }
    private getTagColor(colorClass: string): string {
        // Map color classes to actual colors
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
        return colorMap[colorClass] || '#999';
    }

    private getNodeColor(colorClass: string): string {
        const colorMap: { [key: string]: string } = {
            // Tag colors
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
            // Untagged group colors (muted versions)
            'untagged-group-1': '#8a8a8a',
            'untagged-group-2': '#7c7c7c',
            'untagged-group-3': '#6e6e6e',
            'untagged-group-4': '#606060',
            'untagged-group-5': '#525252'
        };
        return colorMap[colorClass] || '#8a8a8a';
    }
    private getTagColorMap(): { [key: string]: string } {
        return {
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
    }

    private toggleSettings() {
        this.showSettings = !this.showSettings;
        const settingsPanel = this.container.querySelector('.graph-settings');
        if (settingsPanel) {
            if (this.showSettings) {
                settingsPanel.classList.remove('hidden');
            } else {
                settingsPanel.classList.add('hidden');
            }
        }
    }

    private createDragBehavior() {
        const drag = d3.drag<SVGCircleElement, GraphNode, GraphNode>()
            .on('start', (event, d) => {
                console.log('Drag started on node:', d.id);

                // Don't stop the simulation completely, just reduce its influence
                this.simulation.alphaTarget(0.1).restart(); // Keep some simulation running

                d.fx = d.x;
                d.fy = d.y;
            })
            .on('drag', (event, d) => {
                // Update the fixed position to follow mouse exactly
                d.fx = event.x;
                d.fy = event.y;

                // Force immediate visual update without restarting simulation
                this.updatePositions();
            })
            .on('end', (event, d) => {
                console.log('Drag ended');

                // Release the fixed position
                d.fx = null;
                d.fy = null;

                // Give the simulation a boost to settle the graph
                this.simulation.alphaTarget(0);
                this.simulation.alpha(0.3).restart();
            });

        return drag;
    }

    private ticked() {
        this.updatePositions();
    }

    private updateGraphElements() {
        console.log('Updating graph elements');

        // Update nodes - preserve color classes
        this.nodeElements = this.graphG.selectAll<SVGCircleElement, GraphNode>('circle')
            .data(this.nodes, (d: GraphNode) => d.id)
            .join(
                enter => enter.append('circle')
                    .attr('class', (d: GraphNode) => `graph-node ${d.color}`)
                    .attr('r', (d: GraphNode) => d.radius)
                    // REMOVE: .style('fill', '#69b3a2')
                    .style('cursor', 'pointer')
                    .style('stroke', '#333')
                    .style('stroke-width', 2)
                    .call(this.createDragBehavior())
                    .on('mouseover', (event, d) => this.showTooltip(event, d))
                    .on('mouseout', () => this.hideTooltip()),
                update => update
                    .attr('class', (d: GraphNode) => `graph-node ${d.color}`), // Update class on existing nodes
                exit => exit.remove()
            );

        // Update links
        this.linkElements = this.graphG.selectAll<SVGLineElement, GraphLink>('line')
            .data(this.links, (d: GraphLink) => `${d.source.id}-${d.target.id}`)
            .join(
                enter => enter.append('line')
                    .attr('class', (d: GraphLink) => `graph-link ${d.type}`)
                    .style('stroke', (d: GraphLink) => {
                        if (d.type === 'tag-link' && d.tag) {
                            const tag = this.tags.get(d.tag);
                            return tag ? this.getTagColor(tag.color) : '#999';
                        }
                        return '#999';
                    })
                    .style('stroke-width', (d: GraphLink) => d.type === 'tag-link' ? 1.5 : 2)
                    .style('stroke-dasharray', (d: GraphLink) => d.type === 'tag-link' ? '5,5' : 'none')
                    .style('stroke-opacity', 0.6),
                update => update,
                exit => exit.remove()
            );

        // Update labels
        this.labelElements = this.graphG.selectAll<SVGTextElement, GraphNode>('text')
            .data(this.nodes, (d: GraphNode) => d.id)
            .join(
                enter => enter.append('text')
                    .attr('class', 'graph-label')
                    .text((d: GraphNode) => d.name)
                    .attr('text-anchor', 'middle')
                    .attr('dy', -10)
                    .style('font-size', '12px')
                    .style('pointer-events', 'none')
                    .style('fill', '#333')
                    .style('font-weight', 'bold'),
                update => update,
                exit => exit.remove()
            );

        // Re-initialize simulation with new data
        this.initializeSimulation();
    }

    private updatePositions() {
        if (!this.linkElements || !this.nodeElements || !this.labelElements) {
            return;
        }

        // Update link positions
        this.linkElements
            .attr('x1', (d: GraphLink) => d.source.x ?? 0)
            .attr('y1', (d: GraphLink) => d.source.y ?? 0)
            .attr('x2', (d: GraphLink) => d.target.x ?? 0)
            .attr('y2', (d: GraphLink) => d.target.y ?? 0);

        // Update node positions
        this.nodeElements
            .attr('cx', (d: GraphNode) => d.x ?? 0)
            .attr('cy', (d: GraphNode) => d.y ?? 0);

        // Update label positions
        this.labelElements
            .attr('x', (d: GraphNode) => d.x ?? 0)
            .attr('y', (d: GraphNode) => d.y ?? 0);
    }

    private showTooltip(event: MouseEvent, d: GraphNode) {
        this.tooltip.textContent = d.name;
        this.tooltip.style.opacity = '1';
        this.tooltip.style.left = (event.pageX + 10) + 'px';
        this.tooltip.style.top = (event.pageY - 25) + 'px';

        // Highlight connected nodes
        this.highlightConnectedNodes(d);
    }

    private hideTooltip() {
        this.tooltip.style.opacity = '0';
        this.resetNodeStyles();
    }

    private highlightConnectedNodes(centerNode: GraphNode) {
        const connectedNodeIds = new Set<string>();
        connectedNodeIds.add(centerNode.id);

        this.links.forEach(link => {
            if (link.source.id === centerNode.id) connectedNodeIds.add(link.target.id);
            if (link.target.id === centerNode.id) connectedNodeIds.add(link.source.id);
        });

        this.nodeElements
            .style('opacity', (d: GraphNode) => connectedNodeIds.has(d.id) ? '1' : '0.3');

        this.linkElements
            .style('stroke-opacity', (d: GraphLink) =>
                connectedNodeIds.has(d.source.id) && connectedNodeIds.has(d.target.id) ? '0.8' : '0.2'
            );
    }

    private resetNodeStyles() {
        this.nodeElements.style('opacity', '1');
        this.linkElements.style('stroke-opacity', '0.6');
    }

    public updateSimulation() {
        if (!this.simulation) {
            console.log('No simulation to update');
            return;
        }

        console.log('Updating simulation with new settings:', this.settings);

        const containerRect = this.container.getBoundingClientRect();

        // Recreate all forces with new settings
        this.simulation
            .force("link", d3.forceLink<GraphNode, GraphLink>(this.links)
                .id(d => d.id)
                .distance(this.settings.linkDistance)
            )
            .force("charge", d3.forceManyBody<GraphNode>()
                .strength(d => this.settings.charge * (this.settings.repelling / 100))
                .distanceMin(10)
                .distanceMax(200)
            )
            .force("center", d3.forceCenter(containerRect.width / 2, containerRect.height / 2))
            .force("x", d3.forceX(containerRect.width / 2).strength(this.settings.centerStrength))
            .force("y", d3.forceY(containerRect.height / 2).strength(this.settings.gravity))
            .force("collision", d3.forceCollide<GraphNode>()
                .radius(d => d.radius + 5)
                .strength(0.5)
            )
            .alphaDecay(0.1)
            .velocityDecay(0.6)
            .alphaMin(0.001)
            .alpha(0.3)
            .restart();

        console.log('Simulation updated and restarted');
    }

    public centerGraph() {
        if (this.nodes.length === 0) return;

        try {
            const bounds = this.graphG.node()?.getBBox();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;

            const parent = this.graphSvg.node()?.getBoundingClientRect();
            if (!parent) return;

            const fullWidth = parent.width;
            const fullHeight = parent.height;
            const width = bounds.width;
            const height = bounds.height;

            const midX = bounds.x + width / 2;
            const midY = bounds.y + height / 2;

            const scale = 0.85 / Math.max(width / fullWidth, height / fullHeight);
            const translate = [
                fullWidth / 2 - scale * midX,
                fullHeight / 2 - scale * midY
            ];

            this.graphSvg.transition()
                .duration(750)
                .call(
                    d3.zoom<SVGSVGElement, unknown>().transform,
                    d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
                );
        } catch (error) {
            console.error('Error centering graph:', error);
        }
    }

    private setupResizeObserver() {
        const resizeObserver = new ResizeObserver(() => {
            const rect = this.container.getBoundingClientRect();
            this.graphSvg
                .attr('width', rect.width)
                .attr('height', rect.height);

            if (this.simulation) {
                this.simulation.force("center", d3.forceCenter(rect.width / 2, rect.height / 2));
                this.simulation.alpha(0.3).restart();
            }
        });

        resizeObserver.observe(this.container);
    }

    public restartSimulation() {
        if (this.simulation) {
            console.log('Restarting simulation');
            this.simulation.alpha(0.5).restart();
        }
    }

    public destroy() {
        if (this.simulation) {
            this.simulation.stop();
        }
        if (this.graphSvg) {
            this.graphSvg.remove();
        }
        if (this.tooltip) {
            this.tooltip.remove();
        }
    }
}