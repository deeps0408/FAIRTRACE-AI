import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import LogisticRegression from 'ml-logistic-regression';
import { Matrix } from 'ml-matrix';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiRouter = express.Router();

// In-memory storage for the current dataset and models
let currentDataset: any[] = [];
let datasetMetadata: { 
  name: string, 
  size: number, 
  columns: string[],
  validation?: {
    missingValues: Record<string, number>,
    dataTypes: Record<string, string>,
    uniqueValues: Record<string, number>,
    totalRows: number,
    issues: string[]
  }
} | null = null;
let trainedModel: { model: LogisticRegression, features: string[] } | null = null;
let mitigatedModel: { model: LogisticRegression, features: string[] } | null = null;
let sensitiveAttr: string = "";
let privilegedVal: string = "";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  }
});

apiRouter.get('/test', (req, res) => {
  res.json({ message: 'API is working' });
});

// STEP 1: File Upload API
apiRouter.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filename = req.file.originalname.toLowerCase();
    let records: any[] = [];

    if (filename.endsWith('.csv')) {
      // Handle CSV
      let csvData = req.file.buffer.toString('utf-8');
      
      // Strip UTF-8 BOM if present
      if (csvData.charCodeAt(0) === 0xFEFF) {
        csvData = csvData.slice(1);
      }

      // Check for character encoding issues
      if (csvData.includes('\uFFFD')) {
        return res.status(400).json({ 
          error: 'Character encoding issue', 
          message: 'The file appears to contain non-UTF-8 characters. Please ensure your CSV is UTF-8 encoded.' 
        });
      }

      console.log(`Processing CSV file: ${req.file.originalname}, size: ${req.file.size} bytes`);
      
      try {
        records = parse(csvData, {
          columns: true,
          skip_empty_lines: true,
          cast: true,
          relax_column_count: true,
          relax_quotes: true,
          escape: '\\',
          ltrim: true,
          rtrim: true
        });
      } catch (parseErr: any) {
        console.error('CSV Parse Error:', parseErr);
        return res.status(400).json({ 
          error: 'CSV parsing failed', 
          message: `Ensure your CSV is correctly formatted and columns are delimited with commas. Error details: ${parseErr.message || 'Malformed CSV content'}`
        });
      }
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      // Handle Excel
      console.log(`Processing Excel file: ${req.file.originalname}`);
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      records = XLSX.utils.sheet_to_json(worksheet);
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Please upload a .csv or .xlsx file.' });
    }

    console.log(`Parsed ${records.length} records`);

    if (!records || records.length === 0) {
      console.warn('File parsing resulted in 0 records');
      return res.status(400).json({ error: 'File is empty or invalid. Could not extract any data rows.' });
    }

    currentDataset = records;
    
    // Data Validation Logic
    const columns = Object.keys(records[0] || {});
    const totalRows = records.length;
    const missingValues: Record<string, number> = {};
    const dataTypes: Record<string, string> = {};
    const uniqueValues: Record<string, number> = {};
    const issues: string[] = [];

    columns.forEach(col => {
      let missingCount = 0;
      let numericCount = 0;
      const unique = new Set();

      records.forEach(row => {
        const val = row[col];
        if (val === null || val === undefined || val === '') {
          missingCount++;
        } else {
          unique.add(val);
          if (typeof val === 'number' || (typeof val === 'string' && !isNaN(Number(val)) && val.trim() !== '')) {
            numericCount++;
          }
        }
      });

      missingValues[col] = missingCount;
      uniqueValues[col] = unique.size;
      
      const nonMissingCount = totalRows - missingCount;
      if (nonMissingCount > 0 && (numericCount / nonMissingCount) > 0.8) {
        dataTypes[col] = 'numeric';
      } else {
        dataTypes[col] = 'categorical';
      }

      // Detect Issues
      if (missingCount / totalRows > 0.1) {
        issues.push(`Column "${col}" has ${Math.round((missingCount/totalRows)*100)}% missing values.`);
      }
      if (unique.size === 1) {
        issues.push(`Column "${col}" has only one unique value and may not be useful for analysis.`);
      }
      if (unique.size === totalRows && dataTypes[col] === 'categorical' && totalRows > 10) {
        issues.push(`Column "${col}" seems to be an ID column (all unique values).`);
      }
    });

    datasetMetadata = {
      name: req.file.originalname,
      size: records.length,
      columns: columns,
      validation: {
        missingValues,
        dataTypes,
        uniqueValues,
        totalRows,
        issues
      }
    };
    
    // Reset models for the new dataset
    trainedModel = null;
    mitigatedModel = null;
    sensitiveAttr = "";
    privilegedVal = "";

    // Return preview of first 100 rows
    const preview = records.slice(0, 100);

    res.json({ 
      message: 'File uploaded successfully', 
      metadata: datasetMetadata,
      preview: preview
    });
  } catch (err) {
    console.error('File Processing Error:', err);
    res.status(500).json({ 
      error: 'Failed to process data file', 
      message: err instanceof Error ? err.message : String(err) 
    });
  }
});

// STEP 2: Bias Detection Engine
apiRouter.get('/analyze', (req, res) => {
  if (!currentDataset.length) {
    return res.status(400).json({ error: 'No dataset uploaded yet' });
  }

  const { target_attr, sensitive_attr, privileged_value } = req.query;

  if (!target_attr || !sensitive_attr || !privileged_value) {
    return res.status(400).json({ error: 'Missing analysis parameters' });
  }

  const target = String(target_attr);
  const sensitive = String(sensitive_attr);
  const privileged_key = String(privileged_value).trim().toLowerCase();

  // Helper to identify a "time" column
  const dateCol = datasetMetadata?.columns.find(col => 
    /date|time|year|created|timestamp/i.test(col)
  );

  const calcOutcomeRate = (group: any[]) => {
    if (group.length === 0) return 0;
    const positiveOutcomes = group.filter(r => {
      const val = String(r[target]).trim().toLowerCase();
      return val === '1' || val === 'yes' || val === 'true' || val === 'approved' || val === 'success' || val === 'high' || val === 'active' || val === 'positive' || val === 'pass' || val === 'satisfied';
    }).length;
    return positiveOutcomes / group.length;
  };

  const privileged_group = currentDataset.filter(r => String(r[sensitive]).trim().toLowerCase() === privileged_key);
  const unprivileged_group = currentDataset.filter(r => String(r[sensitive]).trim().toLowerCase() !== privileged_key);

  if (privileged_group.length === 0) {
    return res.status(400).json({ 
      error: 'Analysis failed: Invalid privileged value', 
      message: `The privileged value "${privileged_value}" was not found in column "${sensitive}". Please check for typos or case sensitivity.`
    });
  }

  if (unprivileged_group.length === 0) {
    return res.status(400).json({ 
      error: 'Analysis failed: Insufficient diversity', 
      message: `The column "${sensitive}" only contains values matching "${privileged_value}". Analysis requires at least two distinct groups.`
    });
  }

  // Check for variance in target attribute
  const allTargetValues = new Set(currentDataset.map(r => String(r[target]).trim().toLowerCase()));
  if (allTargetValues.size <= 1) {
    return res.status(400).json({ 
      error: 'Analysis failed: Insufficient variance', 
      message: `The target attribute "${target}" has only ${allTargetValues.size} unique value(s). Fairness analysis requires a target with multiple outcomes (e.g., approved/denied).`
    });
  }

  const privileged_rate = calcOutcomeRate(privileged_group);
  const unprivileged_rate = calcOutcomeRate(unprivileged_group);

  const demographic_parity = Math.abs(privileged_rate - unprivileged_rate);
  const disparate_impact = privileged_rate === 0 ? 0 : unprivileged_rate / privileged_rate;

  // Tren Analysis (Trends)
  let sortedData = [...currentDataset];
  if (dateCol) {
    sortedData.sort((a, b) => {
      const dateA = new Date(a[dateCol]).getTime();
      const dateB = new Date(b[dateCol]).getTime();
      return dateA - dateB;
    });
  }

  // Split into buckets (e.g., 5 segments to show trends)
  const bucketCount = 5;
  const bucketSize = Math.ceil(sortedData.length / bucketCount);
  const trends: any[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const bucket = sortedData.slice(i * bucketSize, (i + 1) * bucketSize);
    if (bucket.length === 0) continue;

    const b_privileged = bucket.filter(r => String(r[sensitive]).trim().toLowerCase() === privileged_key);
    const b_unprivileged = bucket.filter(r => String(r[sensitive]).trim().toLowerCase() !== privileged_key);

    const b_privileged_rate = calcOutcomeRate(b_privileged);
    const b_unprivileged_rate = calcOutcomeRate(b_unprivileged);

    const b_disparate_impact = b_privileged_rate === 0 ? 0 : b_unprivileged_rate / b_privileged_rate;
    const b_demographic_parity = Math.abs(b_privileged_rate - b_unprivileged_rate);

    // Label for the bucket
    let label = `Segment ${i + 1}`;
    if (dateCol) {
      const first = bucket[0][dateCol];
      const last = bucket[bucket.length - 1][dateCol];
      label = `${first} - ${last}`;
    }

    trends.push({
      label,
      disparate_impact: b_disparate_impact,
      demographic_parity: b_demographic_parity,
      privileged_rate: b_privileged_rate,
      unprivileged_rate: b_unprivileged_rate,
      size: bucket.length
    });
  }

  res.json({
    metadata: datasetMetadata,
    group_rates: {
      privileged: privileged_rate,
      unprivileged: unprivileged_rate,
    },
    demographic_parity,
    disparate_impact,
    fairness_status: disparate_impact >= 0.8 && disparate_impact <= 1.2 ? 'Fair' : 'Biased',
    trends,
    dateColumnUsed: dateCol || null
  });
});

// STEP 3: Machine Learning Model (Training)
apiRouter.post('/train', (req, res) => {
  if (!currentDataset.length) {
    return res.status(400).json({ error: 'No dataset uploaded yet' });
  }

  const { target_attr, feature_attrs } = req.body;
  if (!target_attr || !feature_attrs || !Array.isArray(feature_attrs)) {
    return res.status(400).json({ error: 'Target and features must be specified' });
  }

  try {
    const target = String(target_attr);
    const features = feature_attrs.map(String);
    
    console.log(`Training with target: ${target}, Features count: ${features.length}`);

    const X_data = currentDataset.map(row => features.map(feat => {
      const val = Number(row[feat]);
      return isNaN(val) ? 0 : val;
    }));
    const y_data = currentDataset.map(row => {
      const val = String(row[target]).trim().toLowerCase();
      return (val === '1' || val === 'yes' || val === 'true' || val === 'approved' || val === 'success' || val === 'high' || val === 'active' || val === 'positive' || val === 'pass' || val === 'satisfied') ? 1 : 0;
    });

    const X = new Matrix(X_data);
    const y = Matrix.columnVector(y_data);

    console.log('Class distribution in y:', y_data.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {} as any));

    const logreg = new LogisticRegression({ numSteps: 1000, learningRate: 5e-3 });
    logreg.train(X, y);

    trainedModel = { model: logreg, features };
    mitigatedModel = null; // Clear any previously calculated mitigated model

    res.json({ message: 'Model trained successfully', features });
  } catch (err) {
    console.error('Training Error:', err);
    res.status(500).json({ error: 'Failed to train model', details: err instanceof Error ? err.message : String(err) });
  }
});

// STEP 4: Prediction
apiRouter.post('/predict', (req, res) => {
  const { input, activeModel } = req.body;
  
  let modelObj = activeModel === 'mitigated' ? mitigatedModel : trainedModel;
  if (!modelObj && !activeModel) {
    modelObj = mitigatedModel || trainedModel;
  }

  if (!modelObj) {
    return res.status(400).json({ error: 'No model trained yet' });
  }

  if (!input || typeof input !== 'object') {
    return res.status(400).json({ error: 'Input data required' });
  }

  try {
    const { model, features } = modelObj;
    console.log(`Predicting with ${activeModel || (mitigatedModel ? 'mitigated' : 'baseline')} model`);
    
    const features_values = features.map(feat => {
      const val = input[feat];
      const num = Number(val);
      return isNaN(num) ? 0 : num;
    });

    const X_input = new Matrix([features_values]);
    const predictions = model.predict(X_input);
    const probability = model.predictProbability(X_input);

    const prob = probability.columns > 1 ? probability.get(0, 1) : probability.get(0, 0);

    res.json({ 
      prediction: predictions[0], 
      probability: prob,
      features: features 
    });
  } catch (err) {
    console.error('Prediction Error:', err);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

// STEP 5: Bias Mitigation
apiRouter.post('/mitigate', (req, res) => {
  if (!currentDataset.length) {
    return res.status(400).json({ error: 'No dataset uploaded yet' });
  }

  const { target_attr, sensitive_attr, privileged_value } = req.body;
  
  try {
    const target = String(target_attr);
    const sensitive = String(sensitive_attr);
    sensitiveAttr = sensitive;
    privilegedVal = String(privileged_value);

    // Blinding: Remove sensitive attribute
    const features = datasetMetadata?.columns.filter(c => c !== target && c !== sensitive) || [];

    const X_data = currentDataset.map(row => features.map(feat => {
      const val = Number(row[feat]);
      return isNaN(val) ? 0 : val;
    }));
    const y_data = currentDataset.map(row => {
      const val = String(row[target]).trim().toLowerCase();
      return (val === '1' || val === 'yes' || val === 'true' || val === 'approved' || val === 'success' || val === 'high' || val === 'active' || val === 'positive' || val === 'pass' || val === 'satisfied') ? 1 : 0;
    });

    const X = new Matrix(X_data);
    const y = Matrix.columnVector(y_data);

    const logreg = new LogisticRegression({ numSteps: 1000, learningRate: 0.01 });
    logreg.train(X, y);

    mitigatedModel = { model: logreg, features };

    res.json({ 
      message: 'Mitigated model trained successfully', 
      removed_feature: sensitive,
      technique: 'Attribute Blinding',
      features
    });
  } catch (err) {
    res.status(500).json({ error: 'Mitigation failed' });
  }
});

async function startServer() {
  console.log('Starting FairTrace AI server...');
  const app = express();
  const PORT = 3000;

  console.log('Applying middleware...');
  app.use(cors());
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  console.log('Registering API routes...');
  
  // Health check at top level for maximum reliability
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FairTrace AI Backend is running', timestamp: new Date().toISOString() });
  });

  app.use('/api', apiRouter);

  // API specific error handler
  app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('API Error:', err);
    res.status(err.status || 500).json({ 
      error: 'API Error', 
      message: err.message || 'An internal error occurred on the API server' 
    });
  });

  // Catch-all for /api routes that don't match anything
  app.use('/api/*', (req, res) => {
    console.warn(`404: API Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
  });

  console.log(`Environment: ${process.env.NODE_ENV}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log('Initializing Vite development server...');
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
        root: process.cwd(),
      });
      app.use(vite.middlewares);
      console.log('Vite middleware integrated.');
    } catch (err) {
      console.error('Failed to create Vite server:', err);
      process.exit(1);
    }
  } else {
    console.log('Production mode enabled. Serving static files.');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`>>> Server listening on http://0.0.0.0:${PORT}`);
    console.log('Server is ready to accept requests.');
  });

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('GLOBAL ERROR:', err);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: err instanceof Error ? err.message : String(err) 
    });
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
