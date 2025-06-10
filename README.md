# 🚀 Eternal Migration Manager

A modern TUI (Text User Interface) manager for database migrations.

## 📦 Installation

```bash
npm install @globalart/typeorm-migration-manager
# or
yarn add @globalart/typeorm-migration-manager
# or
pnpm add @globalart/typeorm-migration-manager
```

## 🎯 Features

- 🖥️ Modern TUI interface
- 🔄 Automatic status updates
- 🔍 Search and filter migrations
- 📊 Detailed migration information
- 🐭 Mouse and keyboard support
- ⚡ Smart caching for performance
- 🎨 Colored output and emojis

## 🚀 Usage

### Basic Usage

```typescript
import { ModernMigrationShell } from '@globalart/typeorm-migration-manager';

const shell = new ModernMigrationShell();
shell.start().catch(console.error);
```

### Advanced Configuration

```typescript
import { ModernMigrationShell } from '@globalart/typeorm-migration-manager';

const config = {
  // Path to migrations directory
  migrationsDir: './custom-migrations',
  
  // Auto-refresh interval in milliseconds
  autoRefreshInterval: 60000,
  
  // Migration commands
  commands: {
    showStatus: 'npm run migration:status',
    migrateUp: 'npm run migrate:up',
    migrateDown: 'npm run migrate:down',
    create: 'npm run migration:create',
    generate: 'npm run migration:generate'
  },
  
  // Database settings
  database: {
    host: 'localhost',
    name: 'my_database'
  }
};

const shell = new ModernMigrationShell(config);
shell.start().catch(console.error);
```

## ⌨️ Hotkeys

- `F1/H` - Show help
- `F2` - Toggle auto-refresh
- `F3` - Search migrations
- `F4` - Cycle filter
- `F5/R` - Refresh data
- `TAB` - Cycle focus between panels
- `N` - Create new migration
- `G` - Generate migration from schema
- `U` - Apply all pending migrations
- `D` - Revert last migration
- `V` - View selected migration content
- `ENTER` - Show migration actions menu
- `Q/ESC` - Quit

## 🛠️ Requirements

- Node.js >= 14
- Supported package managers: npm, yarn, pnpm

## 📝 License

MIT 