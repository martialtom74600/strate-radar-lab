export {
  openDatabase,
  closeDatabase,
  migrateProspectsTable,
  migrateDiamondRescanGuard,
  migrateRadarPlaceLastOutcome,
  migrateRadarWeekPlaceOutcome,
  resolveDbFilePath,
  ProspectRepository,
  type CachedProspectScan,
  type ProspectScanUpsert,
  type ProspectScanMode,
  type WebsiteSource,
} from './database.js';
