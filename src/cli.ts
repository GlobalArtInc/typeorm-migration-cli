#!/usr/bin/env node

import blessed from 'blessed';
import { execSync, spawn } from 'child_process';
import figlet from 'figlet';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

const figletAsync = promisify(figlet);

interface Migration {
  id?: number;
  name: string;
  timestamp: number;
  status: 'pending' | 'applied' | 'failed';
  description?: string;
  size?: string;
  hash?: string;
}

interface DatabaseInfo {
  host: string;
  database: string;
  connected: boolean;
  migrationsCount: number;
  pendingCount: number;
  lastCheck: number;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface MigrationShellConfig {
  migrationsDir?: string;
  autoRefreshInterval?: number;
  commands?: {
    showStatus?: string;
    migrateUp?: string;
    migrateDown?: string;
  };
  database?: {
    host?: string;
    name?: string;
  };
}

class PerformanceCache {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly DEFAULT_TTL = 30000;

  set<T>(key: string, data: T, ttl: number = this.DEFAULT_TTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  clear(): void {
    this.cache.clear();
  }

  invalidate(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}

export class ModernMigrationShell {
  private screen: blessed.Widgets.Screen;
  private config: MigrationShellConfig;
  private migrationsDir: string;
  private autoRefreshInterval: NodeJS.Timeout | null = null;
  private commands: {
    showStatus: string;
    migrateUp: string;
    migrateDown: string;
  };
  private migrations: Migration[] = [];
  private selectedIndex = 0;
  private currentView: 'main' | 'details' | 'logs' = 'main';
  private dbInfo: DatabaseInfo = {
    host: 'localhost',
    database: 'eternal_app',
    connected: false,
    migrationsCount: 0,
    pendingCount: 0,
    lastCheck: 0
  };

  private migrationsList!: blessed.Widgets.ListElement;
  private detailsBox!: blessed.Widgets.BoxElement;
  private menuBar!: blessed.Widgets.BoxElement;
  private logBox!: blessed.Widgets.BoxElement;
  private progressBox!: blessed.Widgets.BoxElement;
  private dbStatusBox!: blessed.Widgets.BoxElement;
  private searchBox!: blessed.Widgets.TextboxElement;
  private filterBox!: blessed.Widgets.BoxElement;

  private cache = new PerformanceCache();
  private isLoading = false;
  private searchTerm = '';
  private filterStatus: 'all' | 'pending' | 'applied' | 'failed' = 'all';
  private logBuffer: string[] = [];
  private readonly MAX_LOG_ENTRIES = 1000;

  constructor(config: MigrationShellConfig = {}) {
    this.config = config;
    this.migrationsDir = config.migrationsDir || path.join(process.cwd(), 'migrations');
    this.commands = {
      showStatus: config.commands?.showStatus || 'pnpm run migration:show',
      migrateUp: config.commands?.migrateUp || 'pnpm run migrate:up',
      migrateDown: config.commands?.migrateDown || 'pnpm run migrate:down'
    };

    this.screen = blessed.screen({
      smartCSR: true,
      title: '🚀 Eternal Migration Manager v2.0',
      mouse: true,
      keys: true,
      vi: true,
      fullUnicode: true,
      dockBorders: true,
      ignoreLocked: ['C-c']
    });

    this.setupLayout();
    this.setupEventHandlers();
    this.setupMouseSupport();
  }

  private setupLayout(): void {
    this.dbStatusBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '33%',
      height: 8,
      label: '📊 Database Status',
      border: { type: 'line' },
      style: {
        fg: 'green',
        border: { fg: 'green' }
      },
      tags: true
    });

    this.progressBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: '33%',
      width: '33%',
      height: 8,
      label: '📈 Progress',
      border: { type: 'line' },
      style: {
        fg: 'yellow',
        border: { fg: 'yellow' }
      },
      tags: true
    });

    this.filterBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: '66%',
      width: '34%',
      height: 8,
      label: '🔍 Filter & Search',
      border: { type: 'line' },
      style: {
        fg: 'yellow',
        border: { fg: 'yellow' }
      },
      tags: true
    });

    this.searchBox = blessed.textbox({
      parent: this.filterBox,
      top: 1,
      left: 1,
      right: 1,
      height: 1,
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'black'
      }
    });

    this.migrationsList = blessed.list({
      parent: this.screen,
      top: 8,
      left: 0,
      width: '70%',
      height: '65%',
      label: '📋 Migrations',
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'blue' },
        selected: {
          bg: 'blue',
          fg: 'white',
          bold: true
        },
        item: {
          hover: {
            bg: 'grey'
          }
        }
      },
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'cyan'
        },
        style: {
          inverse: true
        }
      }
    });

    this.detailsBox = blessed.box({
      parent: this.screen,
      top: 8,
      left: '70%',
      width: '30%',
      height: '65%',
      label: '🔍 Details',
      border: { type: 'line' },
      style: {
        fg: 'yellow',
        border: { fg: 'yellow' }
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true
    });

    this.logBox = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      width: '100%',
      height: 8,
      label: '📝 Logs',
      border: { type: 'line' },
      style: {
        fg: 'magenta',
        border: { fg: 'magenta' }
      },
      tags: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      content: ''
    });

    this.menuBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        fg: 'white',
        bg: 'blue'
      },
      tags: true
    });

    this.updateMenuBar();
    this.updateFilterDisplay();
  }

  private setupEventHandlers(): void {
    this.screen.key(['C-q', 'q'], () => {
      this.showExitConfirmation();
    });

    this.screen.key(['f5', 'r'], () => {
      this.refreshData();
    });

    this.screen.key(['f1', 'h'], () => {
      this.showHelp();
    });

    this.screen.key(['f2'], () => {
      this.toggleAutoRefresh();
    });

    this.screen.key(['f3'], () => {
      this.showSearchDialog();
    });

    this.screen.key(['f4'], () => {
      this.cycleFilter();
    });

    this.screen.key(['tab'], () => {
      this.cycleFocus();
    });

    this.migrationsList.on('select', (item, index) => {
      this.selectedIndex = index;
      this.updateDetails();
    });

    this.migrationsList.key(['enter', 'space'], () => {
      this.showMigrationActions();
    });

    this.migrationsList.key(['v'], () => {
      if (this.migrations[this.selectedIndex]) {
        this.viewMigrationContent(this.migrations[this.selectedIndex]);
      }
    });

    this.screen.key(['n'], () => {
      this.createMigration();
    });

    this.screen.key(['g'], () => {
      this.generateMigration();
    });

    this.screen.key(['u'], () => {
      this.applyMigrations();
    });

    this.screen.key(['d'], () => {
      this.revertMigration();
    });

    this.searchBox.on('submit', (value) => {
      this.searchTerm = value;
      this.applyFilters();
      this.migrationsList.focus();
    });

    this.searchBox.on('cancel', () => {
      this.migrationsList.focus();
    });
  }

  private setupMouseSupport(): void {
    this.migrationsList.on('click', () => {
      this.migrationsList.focus();
    });

    this.detailsBox.on('click', () => {
      this.detailsBox.focus();
    });

    this.logBox.on('click', () => {
      this.logBox.focus();
    });

    this.migrationsList.on('select', (item, index) => {
      this.selectedIndex = index;
      this.updateDetails();
    });
  }

  private setupAutoRefresh(): void {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
    }
    
    this.autoRefreshInterval = setInterval(() => {
      if (!this.isLoading && Date.now() - this.dbInfo.lastCheck > 30000) {
        this.refreshData(true);
      }
    }, 30000);
  }

  private updateMenuBar(): void {
    const menuItems = [
      'F1:Help', 'F2:Auto-refresh', 'F3:Search', 'F4:Filter',
      'N:New', 'G:Generate', 'U:Up', 'D:Down', 'Q:Quit'
    ];
    
    this.menuBar.setContent(`{center}${menuItems.join(' | ')}{/center}`);
  }

  private updateDatabaseStatus(): void {
    const statusIcon = this.dbInfo.connected ? '🟢' : '🔴';
    const lastCheck = this.dbInfo.lastCheck ? 
      new Date(this.dbInfo.lastCheck).toLocaleTimeString() : 'Never';
    
    const content = [
      `${statusIcon} Status: ${this.dbInfo.connected ? 'Connected' : 'Disconnected'}`,
      `🏠 Host: ${this.dbInfo.host}`,
      `💾 Database: ${this.dbInfo.database}`,
      `📊 Total: ${this.dbInfo.migrationsCount}`,
      `⏳ Pending: ${this.dbInfo.pendingCount}`,
      `🕐 Last Check: ${lastCheck}`
    ].join('\n');
    
    this.dbStatusBox.setContent(content);
  }

  private updateProgress(): void {
    const total = this.dbInfo.migrationsCount;
    const applied = total - this.dbInfo.pendingCount;
    const percentage = total > 0 ? Math.round((applied / total) * 100) : 0;
    
    const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    const content = [
      `Progress: ${percentage}%`,
      `[${progressBar}]`,
      `Applied: ${applied}/${total}`,
      `Remaining: ${this.dbInfo.pendingCount}`
    ].join('\n');
    
    this.progressBox.setContent(content);
  }

  private updateFilterDisplay(): void {
    const filterText = [
      `Filter: ${this.filterStatus.toUpperCase()}`,
      this.searchTerm ? `Search: "${this.searchTerm}"` : '',
      `Found: ${this.getFilteredMigrations().length}`
    ].filter(Boolean).join(' | ');
    
    this.filterBox.setLabel(`🔍 ${filterText}`);
  }

  private async loadMigrations(): Promise<void> {
    if (this.isLoading) return;
    
    const cacheKey = 'migrations';
    const cached = this.cache.get<Migration[]>(cacheKey);
    
    if (cached) {
      this.migrations = cached;
      this.updateMigrationsList();
      this.updateProgress();
      return;
    }

    this.isLoading = true;
    this.log('Loading migrations...', 'info');
    
    try {
      try {
        await fs.access(this.migrationsDir);
      } catch {
        await fs.mkdir(this.migrationsDir, { recursive: true });
      }

      const files = await fs.readdir(this.migrationsDir);
      const migrationFiles = files.filter(file => file.endsWith('.ts') || file.endsWith('.js'));

      const migrations: Migration[] = [];
      
      for (const file of migrationFiles) {
        const filePath = path.join(this.migrationsDir, file);
        const stats = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        
        const timestampMatch = file.match(/^(\d+)/);
        const timestamp = timestampMatch ? parseInt(timestampMatch[1]) : stats.birthtimeMs;
        
        const migration: Migration = {
          name: file,
          timestamp,
          status: 'pending',
          description: this.extractDescription(content),
          size: this.formatFileSize(stats.size),
          hash: this.generateHash(content)
        };

        migrations.push(migration);
      }

      migrations.sort((a, b) => a.timestamp - b.timestamp);

      try {
        const statusOutput = execSync(this.commands.showStatus, { 
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        const appliedMigrations = this.parseAppliedMigrations(statusOutput);
        
        migrations.forEach(migration => {
          const baseName = migration.name.replace(/\.(ts|js)$/, '');
          const migrationTimestamp = baseName.match(/^(\d+)/)?.[1];
          
          const isApplied = appliedMigrations.some(appliedName => {
            const appliedTimestamp = appliedName.match(/(\d+)/)?.[1];
            return migrationTimestamp && appliedTimestamp && migrationTimestamp === appliedTimestamp;
          });
          
          if (isApplied) {
            migration.status = 'applied';
          }
        });
        
        this.dbInfo.connected = true;
      } catch (error: unknown) {
        this.dbInfo.connected = false;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log(`Could not fetch migration status: ${errorMessage}`, 'warning');
      }

      this.migrations = migrations;
      this.dbInfo.migrationsCount = migrations.length;
      this.dbInfo.pendingCount = migrations.filter(m => m.status === 'pending').length;
      this.dbInfo.lastCheck = Date.now();

      this.cache.set(cacheKey, migrations, 60000);
      
      this.updateMigrationsList();
      this.updateDatabaseStatus();
      this.updateProgress();
      
      this.log(`Loaded ${migrations.length} migrations`, 'success');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error loading migrations: ${errorMessage}`, 'error');
    } finally {
      this.isLoading = false;
    }
  }

  private parseAppliedMigrations(output: string): string[] {
    const lines = output.split('\n');
    const appliedMigrations: string[] = [];
    
    for (const line of lines) {
      if (line.includes('✓') || line.includes('[X]')) {
        const match = line.match(/(?:\[X\]|✓)\s*\d+\s*(\S+)/);
        if (match) {
          const cleanName = match[1].replace(/\u001b\[[0-9;]*m/g, '');
          appliedMigrations.push(cleanName);
        }
      }
    }
    
    return appliedMigrations;
  }

  private extractDescription(content: string): string {
    const commentMatch = content.match(/\/\*\*(.*?)\*\//s);
    if (commentMatch) {
      return commentMatch[1].replace(/\*/g, '').trim().split('\n')[0].trim();
    }
    
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (classMatch) {
      return classMatch[1].replace(/\d+/, '').replace(/([A-Z])/g, ' $1').trim();
    }
    
    return 'Migration';
  }

  private formatFileSize(bytes: number): string {
    const sizes = ['B', 'KB', 'MB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  private generateHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private getFilteredMigrations(): Migration[] {
    let filtered = this.migrations;
    
    if (this.filterStatus !== 'all') {
      filtered = filtered.filter(m => m.status === this.filterStatus);
    }
    
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      filtered = filtered.filter(m => 
        m.name.toLowerCase().includes(term) ||
        (m.description && m.description.toLowerCase().includes(term))
      );
    }
    
    return filtered;
  }

  private updateMigrationsList(): void {
    const filtered = this.getFilteredMigrations();
    
    const items = filtered.map(migration => {
      const statusIcon = {
        'applied': '✅',
        'pending': '⏳',
        'failed': '❌'
      }[migration.status];
      
      const date = new Date(migration.timestamp).toLocaleDateString();
      const description = migration.description || 'No description';
      
      return `${statusIcon} ${migration.name} | ${date} | ${migration.size} | ${description}`;
    });

    this.migrationsList.setItems(items);
    this.updateFilterDisplay();
    
    if (this.selectedIndex >= filtered.length) {
      this.selectedIndex = Math.max(0, filtered.length - 1);
    }
    
    this.migrationsList.select(this.selectedIndex);
    this.updateDetails();
  }

  private updateDetails(): void {
    const filtered = this.getFilteredMigrations();
    const migration = filtered[this.selectedIndex];
    
    if (!migration) {
      this.detailsBox.setContent('No migration selected');
      return;
    }

    const details = [
      `📄 Name: ${migration.name}`,
      `📅 Date: ${new Date(migration.timestamp).toLocaleString()}`,
      `📊 Status: ${migration.status.toUpperCase()}`,
      `📏 Size: ${migration.size}`,
      `🔗 Hash: ${migration.hash}`,
      '',
      `📝 Description:`,
      migration.description || 'No description available',
      '',
      `⚡ Actions:`,
      '• Press ENTER for actions',
      '• Press V to view content',
      '• Use arrow keys to navigate'
    ].join('\n');

    this.detailsBox.setContent(details);
  }

  private log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const timestamp = new Date().toLocaleTimeString();
    const icons = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌'
    };
    
    const colors = {
      info: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red'
    };

    const logEntry = `{${colors[type]}-fg}[${timestamp}] ${message}{/${colors[type]}-fg}`;
    
    this.logBuffer.push(logEntry);
    
    if (this.logBuffer.length > this.MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-this.MAX_LOG_ENTRIES);
    }
    
    this.logBox.setContent(this.logBuffer.join('\n'));
    this.logBox.setScrollPerc(100);
    this.screen.render();
  }

  private cycleFocus(): void {
    const focusableElements = [this.migrationsList, this.detailsBox, this.logBox, this.searchBox];
    const currentFocused = focusableElements.find(el => (el as any).focused);
    const currentIndex = currentFocused ? focusableElements.indexOf(currentFocused) : -1;
    const nextIndex = (currentIndex + 1) % focusableElements.length;
    
    focusableElements[nextIndex].focus();
    this.screen.render();
  }

  private cycleFilter(): void {
    const filters: Array<typeof this.filterStatus> = ['all', 'pending', 'applied', 'failed'];
    const currentIndex = filters.indexOf(this.filterStatus);
    this.filterStatus = filters[(currentIndex + 1) % filters.length];
    
    this.applyFilters();
    this.log(`Filter changed to: ${this.filterStatus}`, 'info');
  }

  private applyFilters(): void {
    this.updateMigrationsList();
    this.screen.render();
  }

  private showSearchDialog(): void {
    this.searchBox.focus();
    this.searchBox.readInput();
  }

  private toggleAutoRefresh(): void {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
      this.log('Auto-refresh disabled', 'info');
    } else {
      this.setupAutoRefresh();
      this.log('Auto-refresh enabled (30s)', 'info');
    }
  }

  private async showMigrationActions(): Promise<void> {
    const filtered = this.getFilteredMigrations();
    const migration = filtered[this.selectedIndex];
    
    if (!migration) return;

    const actions = [
      'View Content',
      'Apply This Migration',
      'Revert This Migration',
      'Show Details',
      'Cancel'
    ];

    const actionBox = blessed.list({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 40,
      height: actions.length + 4,
      border: { type: 'line' },
      label: ` Actions for ${migration.name} `,
      items: actions,
      keys: true,
      vi: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        selected: {
          bg: 'blue',
          fg: 'white'
        }
      }
    });

    actionBox.on('select', async (item, index) => {
      actionBox.destroy();
      this.screen.render();

      switch (index) {
        case 0:
          await this.viewMigrationContent(migration);
          break;
        case 1:
          await this.applySpecificMigration(migration);
          break;
        case 2:
          await this.revertSpecificMigration(migration);
          break;
        case 3:
          this.showMigrationDetails(migration);
          break;
      }
    });

    actionBox.key(['q', 'escape'], () => {
      actionBox.destroy();
      this.screen.render();
    });

    actionBox.focus();
    this.screen.render();
  }

  private async viewMigrationContent(migration: Migration): Promise<void> {
    try {
      const filePath = path.join(this.migrationsDir, migration.name);
      const content = await fs.readFile(filePath, 'utf-8');
      
      const contentBox = blessed.box({
        parent: this.screen,
        top: 1,
        left: 1,
        right: 1,
        bottom: 1,
        border: { type: 'line' },
        label: ` Content: ${migration.name} `,
        content: content,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        vi: true,
        mouse: true,
        style: {
          border: { fg: 'green' }
        }
      });

      contentBox.key(['q', 'escape'], () => {
        contentBox.destroy();
        this.screen.render();
      });

      contentBox.focus();
      this.screen.render();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error reading migration file: ${errorMessage}`, 'error');
    }
  }

  private showMigrationDetails(migration: Migration): void {
    const details = [
      `Name: ${migration.name}`,
      `Timestamp: ${migration.timestamp}`,
      `Date: ${new Date(migration.timestamp).toLocaleString()}`,
      `Status: ${migration.status}`,
      `Size: ${migration.size}`,
      `Hash: ${migration.hash}`,
      `Description: ${migration.description || 'No description'}`,
      '',
      'Press ESC or Q to close'
    ].join('\n');

    const detailsModal = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 15,
      border: { type: 'line' },
      label: ` Migration Details `,
      content: details,
      keys: true,
      style: {
        border: { fg: 'yellow' }
      }
    });

    detailsModal.key(['q', 'escape'], () => {
      detailsModal.destroy();
      this.screen.render();
    });

    detailsModal.focus();
    this.screen.render();
  }

  private async createMigration(): Promise<void> {
    const nameBox = blessed.textbox({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 3,
      border: { type: 'line' },
      label: ' Migration Name ',
      inputOnFocus: true,
      style: {
        border: { fg: 'green' }
      }
    });

    nameBox.on('submit', async (name) => {
      nameBox.destroy();
      this.screen.render();
      
      if (name.trim()) {
        await this.executeCommand(
          `pnpm run migration:create migrations/${name}`,
          `Creating migration: ${name}`
        );
        this.cache.invalidate('migrations');
        await this.refreshData();
      }
    });

    nameBox.on('cancel', () => {
      nameBox.destroy();
      this.screen.render();
    });

    nameBox.focus();
    this.screen.render();
  }

  private async generateMigration(): Promise<void> {
    const nameBox = blessed.textbox({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 3,
      border: { type: 'line' },
      label: ' Migration Name ',
      inputOnFocus: true,
      style: {
        border: { fg: 'green' }
      }
    });

    nameBox.on('submit', async (name) => {
      nameBox.destroy();
      this.screen.render();
      
      if (name.trim()) {
        await this.executeCommand(
          `pnpm run migration:generate migrations/${name}`,
          `Generating migration: ${name}`
        );
        this.cache.invalidate('migrations');
        await this.refreshData();
      }
    });

    nameBox.on('cancel', () => {
      nameBox.destroy();
      this.screen.render();
    });

    nameBox.focus();
    this.screen.render();
  }

  private async applyMigrations(): Promise<void> {
    const confirmed = await this.showConfirmation(
      'Apply Migrations',
      'Apply all pending migrations?'
    );
    
    if (confirmed) {
      await this.executeCommand(
        this.commands.migrateUp,
        'Applying migrations'
      );
      this.cache.invalidate('migrations');
      await this.refreshData();
    }
  }

  private async revertMigration(): Promise<void> {
    const confirmed = await this.showConfirmation(
      'Revert Migration',
      'Revert the last applied migration?'
    );
    
    if (confirmed) {
      await this.executeCommand(
        this.commands.migrateDown,
        'Reverting migration'
      );
      this.cache.invalidate('migrations');
      await this.refreshData();
    }
  }

  private async applySpecificMigration(migration: Migration): Promise<void> {
    this.log(`Applying specific migration not directly supported. Use 'Apply All' instead.`, 'warning');
  }

  private async revertSpecificMigration(migration: Migration): Promise<void> {
    this.log(`Reverting specific migration not directly supported. Use 'Revert Last' instead.`, 'warning');
  }

  private async executeCommand(command: string, description: string): Promise<void> {
    this.log(`${description}...`, 'info');
    
    try {
      const child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) {
            this.log(`${description} completed successfully`, 'success');
            if (output.trim()) {
              this.log(output.trim(), 'info');
            }
            resolve();
          } else {
            this.log(`${description} failed with code ${code}`, 'error');
            if (errorOutput.trim()) {
              this.log(errorOutput.trim(), 'error');
            }
            reject(new Error(`Command failed with code ${code}`));
          }
        });

        child.on('error', (error) => {
          this.log(`${description} failed: ${error.message}`, 'error');
          reject(error);
        });
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error executing command: ${errorMessage}`, 'error');
    }
  }

  private async showConfirmation(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const confirmBox = blessed.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: 50,
        height: 7,
        border: { type: 'line' },
        label: ` ${title} `,
        content: `{center}${message}{/center}\n\n{center}Press Y to confirm, N to cancel{/center}`,
        tags: true,
        keys: true,
        style: {
          border: { fg: 'yellow' }
        }
      });

      confirmBox.key(['y', 'Y'], () => {
        confirmBox.destroy();
        this.screen.render();
        resolve(true);
      });

      confirmBox.key(['n', 'N', 'escape'], () => {
        confirmBox.destroy();
        this.screen.render();
        resolve(false);
      });

      confirmBox.focus();
      this.screen.render();
    });
  }

  private showMessage(message: string, type: 'info' | 'success' | 'warning' | 'error'): void {
    const colors = {
      info: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red'
    };

    const messageBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 6,
      border: { type: 'line' },
      content: `{center}${message}{/center}\n\n{center}Press any key to continue{/center}`,
      tags: true,
      keys: true,
      style: {
        border: { fg: colors[type] }
      }
    });

    messageBox.key(['enter', 'escape', 'space'], () => {
      messageBox.destroy();
      this.screen.render();
    });

    messageBox.focus();
    this.screen.render();
  }

  private showHelp(): void {
    const helpContent = [
      '{bold}{cyan-fg}🚀 Eternal Migration Manager v2.0 - Help{/cyan-fg}{/bold}',
      '',
      '{bold}Navigation:{/bold}',
      '• Arrow keys or mouse to navigate',
      '• TAB to cycle between panels',
      '• Click on panels to focus them',
      '• Double-click or ENTER for actions',
      '',
      '{bold}Keyboard Shortcuts:{/bold}',
      '• {bold}F1/H{/bold} - Show this help',
      '• {bold}F2{/bold} - Toggle auto-refresh (30s)',
      '• {bold}F3{/bold} - Search migrations',
      '• {bold}F4{/bold} - Cycle filter (all/pending/applied/failed)',
      '• {bold}F5/R{/bold} - Refresh data',
      '• {bold}TAB{/bold} - Cycle focus between panels',
      '',
      '{bold}Migration Actions:{/bold}',
      '• {bold}N{/bold} - Create new migration',
      '• {bold}G{/bold} - Generate migration from schema',
      '• {bold}U{/bold} - Apply all pending migrations',
      '• {bold}D{/bold} - Revert last migration',
      '• {bold}V{/bold} - View selected migration content',
      '• {bold}ENTER{/bold} - Show migration actions menu',
      '',
      '{bold}Database:{/bold}',
      '• {bold}S{/bold} - Show migration status',
      '• {bold}C{/bold} - Test database connection',
      '',
      '{bold}General:{/bold}',
      '• {bold}Q/ESC{/bold} - Quit application',
      '',
      '{bold}Features:{/bold}',
      '• Real-time migration status',
      '• Smart caching for performance',
      '• Auto-refresh every 30 seconds',
      '• Search and filter migrations',
      '• Detailed migration information',
      '• Mouse and keyboard support',
      '',
      '{bold}Tips:{/bold}',
      '• Always backup before migrations',
      '• Test in development first',
      '• Review generated migrations',
      '• Use descriptive migration names'
    ].join('\n');

    const helpBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 'center',
      width: '80%',
      height: '90%',
      border: { type: 'line' },
      label: ' 📚 Help ',
      content: helpContent,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' }
      }
    });

    helpBox.key(['q', 'escape'], () => {
      helpBox.destroy();
      this.screen.render();
    });

    helpBox.focus();
    this.screen.render();
  }

  private showExitConfirmation(): void {
    const exitBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 40,
      height: 6,
      border: { type: 'line' },
      label: ' 👋 Exit ',
      content: '{center}Are you sure you want to exit?{/center}\n\n{center}Press Y to exit, N to stay{/center}',
      tags: true,
      keys: true,
      style: {
        border: { fg: 'red' }
      }
    });

    exitBox.key(['y', 'Y'], () => {
      if (this.autoRefreshInterval) {
        clearInterval(this.autoRefreshInterval);
      }
      process.exit(0);
    });

    exitBox.key(['n', 'N', 'escape'], () => {
      exitBox.destroy();
      this.screen.render();
    });

    exitBox.focus();
    this.screen.render();
  }

  private async refreshData(silent: boolean = false): Promise<void> {
    if (!silent) {
      this.log('Refreshing data...', 'info');
    }
    
    this.cache.clear();
    await this.loadMigrations();
    await this.connectToDatabase();
    this.updateDetails();
    this.screen.render();
  }

  private async showMigrationStatus(): Promise<void> {
    try {
      const output = execSync(this.commands.showStatus, { 
        encoding: 'utf-8',
        timeout: 10000
      });
      
      const statusBox = blessed.box({
        parent: this.screen,
        top: 2,
        left: 'center',
        width: '80%',
        height: '80%',
        border: { type: 'line' },
        label: ' 📊 Migration Status ',
        content: output,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        vi: true,
        mouse: true,
        style: {
          border: { fg: 'blue' }
        }
      });

      statusBox.key(['q', 'escape'], () => {
        statusBox.destroy();
        this.screen.render();
      });

      statusBox.focus();
      this.screen.render();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error getting migration status: ${errorMessage}`, 'error');
    }
  }

  private async connectToDatabase(): Promise<void> {
    if (!this.dbInfo.connected) {
      this.log('Testing database connection...', 'info');
    }
    
    try {
      execSync(this.commands.showStatus, { 
        encoding: 'utf-8', 
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      if (!this.dbInfo.connected) {
        this.dbInfo.connected = true;
        this.updateDatabaseStatus();
        this.log('Database connection successful', 'success');
      }
    } catch (error: unknown) {
      if (this.dbInfo.connected) {
        this.dbInfo.connected = false;
        this.updateDatabaseStatus();
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log(`Database connection lost: ${errorMessage}`, 'error');
      }
    }
    
    this.screen.render();
  }

  public async start(): Promise<void> {
    this.log('Starting Migration Manager...', 'info');
    
    await this.loadMigrations();
    await this.connectToDatabase();
    this.migrationsList.focus();
    this.screen.render();
  }
} 