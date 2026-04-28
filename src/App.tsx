/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  BarChart3, 
  Zap, 
  ShieldCheck, 
  FileUp, 
  AlertCircle, 
  CheckCircle2,
  BrainCircuit,
  Database,
  ArrowRight,
  TrendingDown,
  TrendingUp,
  FileText,
  User,
  LogOut,
  LogIn,
  ChevronUp,
  ChevronDown,
  Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import jsPDF from 'jspdf';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  LineChart,
  Line,
  Legend,
  AreaChart,
  Area
} from 'recharts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import { auth, db } from './lib/firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  getDocs, 
  serverTimestamp,
  doc,
  getDocFromServer,
  updateDoc
} from 'firebase/firestore';

// Helper for tailwind class merging
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Types
interface DatasetMetadata {
  id?: string;
  name: string;
  size: number;
  columns: string[];
  preview?: any[];
  validation?: {
    missingValues: Record<string, number>;
    dataTypes: Record<string, string>;
    uniqueValues: Record<string, number>;
    totalRows: number;
    issues: string[];
  };
}

interface AnalysisResults {
  id?: string;
  metadata?: DatasetMetadata;
  group_rates: {
    privileged: number;
    unprivileged: number;
  };
  demographic_parity: number;
  disparate_impact: number;
  fairness_status: string;
  trends?: {
    label: string;
    disparate_impact: number;
    demographic_parity: number;
    privileged_rate: number;
    unprivileged_rate: number;
    size: number;
  }[];
  dateColumnUsed?: string | null;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface FairTraceError {
  id: string;
  message: string;
  type: 'upload' | 'analysis' | 'training' | 'prediction' | 'database' | 'general';
  timestamp: Date;
  details?: string;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'analysis' | 'simulations' | 'mitigation'>('dashboard');
  const [isUploading, setIsUploading] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPredicting, setIsPredicting] = useState(false);
  const [activeModel, setActiveModel] = useState<'baseline' | 'mitigated'>('baseline');
  const [isExporting, setIsExporting] = useState(false);
  const [dataset, setDataset] = useState<DatasetMetadata | null>(null);
  const [userDatasets, setUserDatasets] = useState<DatasetMetadata[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResults | null>(null);
  const [predictionInput, setPredictionInput] = useState<Record<string, string>>({});
  const [predictionResult, setPredictionResult] = useState<any>(null);
  const [errors, setErrors] = useState<FairTraceError[]>([]);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [mitigationInfo, setMitigationInfo] = useState<any>(null);
  const [trendRange, setTrendRange] = useState<[number, number]>([0, 4]);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewSearchQuery, setPreviewSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 10;

  const pushError = (message: string, type: FairTraceError['type'], details?: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setErrors(prev => [{ id, message, type, timestamp: new Date(), details }, ...prev]);
  };

  const clearError = (id: string) => {
    setErrors(prev => prev.filter(e => e.id !== id));
  };

  // Auth Effect
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isAuthLoading) {
        setIsAuthLoading(false);
        pushError("Authentication service is taking longer than expected. Please check your connection.", 'general');
      }
    }, 8000); // 8 second timeout

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      clearTimeout(timer);
      setUser(u);
      setIsAuthLoading(false);
      if (u) {
        fetchUserDatasets(u.uid);
        testConnection();
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const testConnection = async () => {
    const path = 'test/connection';
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
    } catch (e) {
      if (e instanceof Error && e.message.includes('offline')) {
        console.warn("Firestore appears offline during initial test");
      } else {
        const errInfo = {
          error: e instanceof Error ? e.message : String(e),
          operation: 'GET',
          path
        };
        pushError("Database Connection Restricted", 'database', JSON.stringify(errInfo, null, 2));
      }
    }
  };

  const fetchUserDatasets = async (userId: string) => {
    const path = 'datasets';
    try {
      const q = query(collection(db, path), where('userId', '==', userId));
      const snapshot = await getDocs(q);
      const datasets = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as DatasetMetadata));
      setUserDatasets(datasets);
    } catch (err) {
      pushError("Failed to fetch user datasets", 'database', err instanceof Error ? err.message : String(err));
    }
  };

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      pushError("Login failed", 'general', err instanceof Error ? err.message : undefined);
    }
  };

  const logout = async () => {
    await signOut(auth);
    setDataset(null);
    setAnalysis(null);
    setUserDatasets([]);
  };

  const performMitigation = async () => {
    if (!dataset) return;
    setIsTraining(true);

    try {
      const res = await fetch('/api/mitigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          target_attr: selectedTarget, 
          sensitive_attr: selectedSensitive,
          privileged_value: privilegedInput 
        }),
      });

      const contentType = res.headers.get('content-type');
      const rawText = await res.text();
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          throw new Error(`Invalid JSON from server during mitigation. Status: ${res.status}`);
        }
      } else {
        throw new Error(`Expected JSON during mitigation but got ${contentType}. Status: ${res.status}`);
      }

      if (res.ok) {
        setMitigationInfo(data);
        setPredictionResult(null); // Clear old results
        setActiveModel('mitigated');
        if (data.features) {
          setPredictionInput(data.features.reduce((acc: any, feat: string) => ({ ...acc, [feat]: '0' }), {}));
        }
        setActiveTab('mitigation');
      } else {
        pushError(data.error || 'Mitigation failed', 'training');
      }
    } catch (err) {
      const details = err instanceof Error ? err.message : undefined;
      pushError('An error occurred during mitigation training', 'training', details);
    } finally {
      setIsTraining(false);
    }
  };

  const generateReport = async () => {
    if (!analysis || !dataset) return;
    setIsGeneratingReport(true);
    setAiReport(null);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const sensitive = selectedSensitive || 'Sensitive Attribute';

      const prompt = `
        You are an AI Fairness & Explainability Expert (specializing in LIME/SHAP concepts). 
        Analyze these metrics from a dataset named "${dataset.name}":
        - Sensitive Attribute: ${sensitive}
        - Target Variable: ${selectedTarget || 'Unknown'}
        - Disparate Impact (DI): ${analysis.disparate_impact.toFixed(2)}
        - Demographic Parity Gap (DP): ${analysis.demographic_parity.toFixed(2)}
        - Fairness Status: ${analysis.fairness_status}
        - Mitigation Strategy: ${mitigationInfo ? mitigationInfo.technique : 'None (Baseline Analysis)'}

        Produce a comprehensive AI Fairness Audit Report with the following refined structure:
        
        ### 1. Metric Deep-Dive & Regulatory Context
        Explain the results of Disparate Impact (${analysis.disparate_impact.toFixed(2)}) and Demographic Parity (${analysis.demographic_parity.toFixed(2)}). 
        Reference the "80% Rule" (Four-fifths rule) and explain how these metrics indicate systemic bias or algorithmic neutrality. 
        Interpret what these values mean for the ${sensitive} group.

        ### 2. Feature Attribution & Proxy Analysis (Explainability)
        Discuss how latent correlations in the dataset might act as "fairness proxies." 
        Similar to how SHAP (SHapley Additive exPlanations) would distribute feature importance, explain how non-sensitive features might be indirectly leaking bias. 
        Identify potential "Red Flags" where feature interactions could reinforce historical prejudice.

        ### 3. Mitigation Technical Assessment
        Evaluate the strategy used: "${mitigationInfo ? mitigationInfo.technique : 'Baseline'}". 
        If Attribute Blinding was used, explain its mechanism and its critical limitation: "Proxy Leakage." 
        Discuss why simply removing ${sensitive} often fails to eliminate bias due to redundant encodings in remaining data (e.g., zip code correlating with race).
        
        ### 4. Advanced Strategic Recommendations
        Suggest 3 advanced technical interventions (e.g., Adversarial Debiasing, Equalized Odds post-processing, or Re-weighing) that provide more robust protection than simple blinding.

        Use a technical yet accessible, professional tone. Format strictly with Markdown.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });

      if (response.text) {
        setAiReport(response.text);

        // Update Firestore with AI Report
        if (user && dataset.id && analysis.id) {
          const path = `datasets/${dataset.id}/analysis/${analysis.id}`;
          try {
            await updateDoc(doc(db, 'datasets', dataset.id, 'analysis', analysis.id), {
              aiReport: response.text
            });
          } catch (fireErr) {
            pushError("Failed to save AI report to database", 'database', fireErr instanceof Error ? fireErr.message : String(fireErr));
          }
        }
      } else {
        throw new Error('Empty response from AI');
      }
    } catch (err) {
      console.error('Gemini Error:', err);
      pushError('AI Report generation failed', 'analysis', 'Please check your API key configuration or network connectivity.');
    } finally {
      setIsGeneratingReport(false);
    }
  };

  useEffect(() => {
    fetch('/api/health').catch(() => pushError('Backend unreachable', 'general', 'The production server is not responding to health checks. Check network firewalls.'));
  }, []);

  const filteredPreview = React.useMemo(() => {
    if (!dataset?.preview) return [];
    let filtered = [...dataset.preview];

    if (previewSearchQuery) {
      const query = previewSearchQuery.toLowerCase();
      filtered = filtered.filter(row => 
        Object.values(row).some(val => String(val).toLowerCase().includes(query))
      );
    }

    if (sortConfig) {
      filtered.sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [dataset?.preview, previewSearchQuery, sortConfig]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setIsUploading(true);
    
    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      console.log('Initiating upload for:', selectedFile.name);
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      
      console.log('Server response status:', res.status);
      const contentType = res.headers.get('content-type');
      let data;
      const rawText = await res.text();
      
      if (contentType && contentType.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch (parseErr) {
          console.error('JSON Parse Error:', parseErr);
          throw new Error(`Server returned invalid JSON. Please ensure your file is a valid CSV. Technical details: ${rawText.substring(0, 50)}...`);
        }
      } else {
        console.error('Non-JSON response received:', rawText.substring(0, 500));
        if (rawText.includes('<title>Cookie check</title>') || rawText.includes('cookie-check')) {
          throw new Error(`Security session expired. Please refresh the page and try your upload again.`);
        }
        throw new Error(`The server encountered an unexpected error (Status: ${res.status}). Please ensure your CSV is UTF-8 encoded and follows standard formatting.`);
      }

      if (res.ok) {
        console.log('Upload successful, metadata received:', data.metadata);
        const metadata = data.metadata;
        
        // Save to Firestore if user is logged in
        if (user) {
          const path = 'datasets';
          try {
            const docRef = await addDoc(collection(db, path), {
              ...metadata,
              userId: user.uid,
              createdAt: serverTimestamp()
            });
            metadata.id = docRef.id;
            setUserDatasets(prev => [...prev, metadata]);
          } catch (fireErr) {
            pushError("Failed to persist dataset metadata", 'database', fireErr instanceof Error ? fireErr.message : String(fireErr));
          }
        }
        
        setDataset({ ...metadata, preview: data.preview });
        setAnalysis(null);
        setPredictionResult(null);
        setMitigationInfo(null);
        setAiReport(null);
        
        // Reset selections for the new dataset
        const target = metadata.columns.find((c: string) => c.toLowerCase().includes('label') || c.toLowerCase().includes('target') || c.toLowerCase().includes('outcome')) || metadata.columns[0];
        setSelectedTarget(target);
        const sensitive = metadata.columns.find((c: string) => c.toLowerCase().includes('gender') || c.toLowerCase().includes('race') || c.toLowerCase().includes('age')) || metadata.columns[1];
        setSelectedSensitive(sensitive);

        setActiveTab('analysis'); 
        setCurrentPage(1);
        setSearchQuery('');
      } else {
        pushError(data.error || 'Upload failed', 'upload', data.message);
      }
    } catch (err) {
      pushError('File Upload Failed', 'upload', err instanceof Error ? err.message : 'An unknown error occurred during upload. Please check your internet connection.');
    } finally {
      setIsUploading(false);
    }
  };

  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedSensitive, setSelectedSensitive] = useState('');
  const [privilegedInput, setPrivilegedInput] = useState('Male');

  useEffect(() => {
    if (dataset) {
      const bestTarget = dataset.columns.find(c => c.toLowerCase().includes('label') || c.toLowerCase().includes('target') || c.toLowerCase().includes('outcome')) || dataset.columns[0] || '';
      
      if (!selectedTarget || !dataset.columns.includes(selectedTarget)) {
        setSelectedTarget(bestTarget);
      }

      const currentTarget = (!selectedTarget || !dataset.columns.includes(selectedTarget)) ? bestTarget : selectedTarget;
      
      if (!selectedSensitive || !dataset.columns.includes(selectedSensitive) || selectedSensitive === currentTarget) {
        const bestSensitive = dataset.columns.find(c => c !== currentTarget && (c.toLowerCase().includes('gender') || c.toLowerCase().includes('race') || c.toLowerCase().includes('age'))) || 
                             dataset.columns.find(c => c !== currentTarget) || 
                             dataset.columns[1] || 
                             dataset.columns[0] || '';
        
        if (bestSensitive && bestSensitive !== selectedSensitive) {
          setSelectedSensitive(bestSensitive);
        }
      }
    }
  }, [dataset, selectedTarget, selectedSensitive]);

  const downloadReport = async () => {
    if (!analysis || !dataset) return;
    setIsExporting(true);
    
    try {
      const doc = new jsPDF();
      
      // Header
      doc.setFontSize(22);
      doc.setTextColor(30, 41, 59); // slate-800
      doc.text('EthiAI: Bias Analysis Report', 20, 30);
      
      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139); // slate-500
      doc.text(`Generated on: ${new Date().toLocaleString()}`, 20, 40);
      doc.text(`Dataset: ${dataset.name}`, 20, 45);
      
      // Metrics Section
      doc.setFontSize(16);
      doc.setTextColor(30, 41, 59);
      doc.text('Fairness Metrics', 20, 60);
      
      doc.setFontSize(12);
      doc.text(`Target Outcome: ${selectedTarget || 'Not specified'}`, 20, 75);
      doc.text(`Sensitive Attribute: ${selectedSensitive || 'Not specified'}`, 20, 82);
      doc.text(`Privileged Value: ${privilegedInput || 'Not specified'}`, 20, 89);
      
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.line(20, 95, 190, 95);
      
      doc.text(`Disparate Impact: ${analysis.disparate_impact?.toFixed(4) || 'N/A'}`, 20, 105);
      doc.text(`Demographic Parity: ${analysis.demographic_parity?.toFixed(4) || 'N/A'}`, 20, 112);
      doc.text(`Fairness Status: ${analysis.fairness_status || 'N/A'}`, 20, 119);
      
      // Outcome Rates
      if (analysis.group_rates) {
        doc.text(`Privileged Group Rate: ${((analysis.group_rates.privileged ?? 0) * 100).toFixed(2)}%`, 20, 126);
        doc.text(`Unprivileged Group Rate: ${((analysis.group_rates.unprivileged ?? 0) * 100).toFixed(2)}%`, 20, 133);
      }
      
      // AI Report Section
      if (aiReport) {
        doc.addPage();
        doc.setFontSize(16);
        doc.setTextColor(30, 41, 59);
        doc.text('AI Fairness Expert Evaluation', 20, 30);
        
        doc.setFontSize(10);
        doc.setTextColor(51, 65, 85); // slate-700
        
        const cleanReport = aiReport.replace(/[#*`]/g, '');
        const splitText = doc.splitTextToSize(cleanReport, 170);
        doc.text(splitText, 20, 45);
      }
      
      doc.save(`EthiAI-Report-${dataset.name.replace(/\s+/g, '-').toLowerCase()}.pdf`);
    } catch (err) {
      pushError('Failed to generate PDF report', 'general', err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const runAnalysis = async () => {
    if (!dataset) {
      console.error('No dataset loaded');
      return;
    }

    // Capture the latest valid columns or fallback immediately to ensure we have values
    const getBestTarget = () => {
      if (selectedTarget && dataset.columns.includes(selectedTarget)) return selectedTarget;
      return dataset.columns.find(c => c.toLowerCase().includes('label') || c.toLowerCase().includes('target') || c.toLowerCase().includes('outcome')) || dataset.columns[0] || '';
    };

    const getBestSensitive = () => {
      if (selectedSensitive && dataset.columns.includes(selectedSensitive)) return selectedSensitive;
      // Try to find a different column than target for sensitive attribute
      const target = getBestTarget();
      return dataset.columns.find(c => c !== target && (c.toLowerCase().includes('gender') || c.toLowerCase().includes('race') || c.toLowerCase().includes('age'))) || 
             dataset.columns.find(c => c !== target) || 
             dataset.columns[1] || 
             dataset.columns[0] || '';
    };

    const target = getBestTarget();
    const sensitive = getBestSensitive();

    // Update state to match our resolved values for UI consistency
    if (target !== selectedTarget) setSelectedTarget(target);
    if (sensitive !== selectedSensitive) setSelectedSensitive(sensitive);

    if (!target || !sensitive) {
      pushError('Analysis requires at least two columns: a Target and a Sensitive attribute.', 'analysis');
      return;
    }

    setIsAnalyzing(true);
    setAnalysis(null);
    setAiReport(null);
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const res = await fetch(`/api/analyze?target_attr=${encodeURIComponent(target)}&sensitive_attr=${encodeURIComponent(sensitive)}&privileged_value=${encodeURIComponent(privilegedInput)}`);
      
      const contentType = res.headers.get('content-type');
      const rawText = await res.text();
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          throw new Error(`Invalid JSON from server. Status: ${res.status}`);
        }
      } else {
        throw new Error(`Expected JSON but got ${contentType}. Status: ${res.status}. Preview: ${rawText.substring(0, 100)}`);
      }

      if (res.ok) {
        let analysisData = { ...data, targetAttr: target, sensitiveAttr: sensitive, privilegedValue: privilegedInput };

        // Save analysis result to Firestore
        if (user && dataset.id) {
          try {
            const analysisRef = await addDoc(collection(db, 'datasets', dataset.id, 'analysis'), {
              datasetId: dataset.id,
              group_rates: data.group_rates,
              demographic_parity: data.demographic_parity,
              disparate_impact: data.disparate_impact,
              fairness_status: data.fairness_status,
              targetAttr: selectedTarget,
              sensitiveAttr: selectedSensitive,
              privilegedValue: privilegedInput,
              userId: user.uid,
              createdAt: serverTimestamp()
            });
            analysisData.id = analysisRef.id;
          } catch (fireErr) {
            pushError("Failed to save analysis results", 'database', fireErr instanceof Error ? fireErr.message : String(fireErr));
          }
        }
        setAnalysis(analysisData);
      } else {
        pushError(data.error || 'Analysis failed', 'analysis', data.message);
      }
    } catch (err) {
      pushError('Analysis Engine Error', 'analysis', err instanceof Error ? err.message : 'The analysis engine encountered an unexpected problem. Please verify your attribute selections.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const trainModel = async () => {
    if (!dataset) return;
    setIsTraining(true);
    
    // Ensure we have a target selected
    const target = selectedTarget || dataset.columns.find(c => c.toLowerCase().includes('label') || c.toLowerCase().includes('target') || c.toLowerCase().includes('outcome')) || dataset.columns[0];
    const features = dataset.columns.filter(c => c !== target);
    
    if (target !== selectedTarget) setSelectedTarget(target);

    try {
      console.log('Training model with target:', target, 'and features:', features);
      // Simulate heavy compute for demo
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const res = await fetch('/api/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_attr: target, feature_attrs: features }),
      });
      
      const contentType = res.headers.get('content-type');
      const rawText = await res.text();
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          throw new Error(`Invalid JSON from server during training. Status: ${res.status}`);
        }
      } else {
        throw new Error(`Expected JSON during training but got ${contentType}. Status: ${res.status}`);
      }

      if (res.ok) {
        setPredictionResult(null); // Clear old result
        setActiveModel('baseline');
        setPredictionInput(features.reduce((acc, feat) => ({ ...acc, [feat]: '0' }), {}));
      } else {
        pushError(data.error || 'Training failed', 'training');
      }
    } catch (err) {
      pushError('An error occurred during training', 'training', err instanceof Error ? err.message : undefined);
    } finally {
      setIsTraining(false);
    }
  };

  const getPrediction = async () => {
    setIsPredicting(true);
    try {
      // Small delay for UI smoothness
      await new Promise(resolve => setTimeout(resolve, 800));
      
      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: predictionInput, activeModel: activeModel }),
      });
      
      const contentType = res.headers.get('content-type');
      const rawText = await res.text();
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          throw new Error(`Invalid JSON from server during prediction. Status: ${res.status}`);
        }
      } else {
        throw new Error(`Expected JSON during prediction but got ${contentType}. Status: ${res.status}`);
      }

      if (res.ok) {
        setPredictionResult(data);
      } else {
        pushError(data.error || 'Prediction failed', 'prediction');
      }
    } catch (err) {
      pushError('An error occurred during prediction', 'prediction', err instanceof Error ? err.message : undefined);
    } finally {
      setIsPredicting(false);
    }
  };

  const chartData = analysis ? [
    { name: 'Privileged', rate: (analysis.group_rates?.privileged ?? 0) * 100 },
    { name: 'Unprivileged', rate: (analysis.group_rates?.unprivileged ?? 0) * 100 },
  ] : [];

  if (isAuthLoading) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-50 gap-4">
        <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400 font-medium animate-pulse">Initializing FairTrace AI...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-[2rem] p-10 shadow-2xl shadow-indigo-100 border border-slate-100 text-center">
           <div className="h-16 w-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg shadow-indigo-200">
              <ShieldCheck className="w-10 h-10 text-white" />
           </div>
           <h1 className="text-3xl font-bold text-slate-800 mb-2">FairTrace AI</h1>
           <p className="text-slate-500 mb-10">Advanced Bias Detection & Fairness Management for Enterprise Machine Learning.</p>
           
           <AnimatePresence>
             {errors.length > 0 && <DiagnosticCenter errors={errors} onClear={clearError} />}
           </AnimatePresence>

           <button 
            onClick={login}
            className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold flex items-center justify-center gap-3 hover:bg-slate-800 transition-all group"
           >
              <LogIn className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              Sign in with Google
           </button>
           
           <div className="mt-8 flex items-center gap-2 justify-center text-[10px] font-bold text-slate-300 uppercase tracking-widest">
              <span>Secure</span>
              <div className="w-1 h-1 rounded-full bg-slate-200" />
              <span>Transparent</span>
              <div className="w-1 h-1 rounded-full bg-slate-200" />
              <span>Auditable</span>
           </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-6 flex items-center gap-3">
          <div className="h-8 w-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-200">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight text-slate-800">FairTrace AI</span>
        </div>
        
        <nav className="flex-1 px-4 space-y-1 py-4">
          <NavButton 
            active={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')}
            icon={<LayoutDashboard className="w-5 h-5" />}
            label="Dashboard"
          />
          <NavButton 
            active={activeTab === 'analysis'} 
            onClick={() => setActiveTab('analysis')}
            icon={<BarChart3 className="w-5 h-5" />}
            label="Analysis"
          />
          <NavButton 
            active={activeTab === 'simulations'} 
            onClick={() => setActiveTab('simulations')}
            icon={<Zap className="w-5 h-5" />}
            label="Simulations"
          />
          <NavButton 
            active={activeTab === 'mitigation'} 
            onClick={() => setActiveTab('mitigation')}
            icon={<BrainCircuit className="w-5 h-5" />}
            label="Mitigation"
          />
        </nav>

        {userDatasets.length > 0 && (
          <div className="px-6 py-4 flex-1 overflow-y-auto">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Recent Datasets</h3>
            <div className="space-y-2">
              {userDatasets.slice(0, 5).map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setDataset(d);
                    setAnalysis(null);
                    setAiReport(null);
                    setActiveTab('dashboard');
                  }}
                  className={cn(
                    "w-full text-left p-3 rounded-xl border border-transparent transition-all group",
                    dataset?.id === d.id ? "bg-white border-slate-200 shadow-sm" : "hover:bg-slate-50"
                  )}
                >
                  <p className="text-xs font-bold text-slate-700 truncate group-hover:text-indigo-600 transition-colors">{d.name}</p>
                  <p className="text-[10px] text-slate-400">{d.size.toLocaleString()} samples</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-slate-100 space-y-3">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
            <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center border-2 border-white overflow-hidden">
              {user.photoURL ? (
                <img src={user.photoURL} alt={user.displayName || 'User'} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <User className="w-5 h-5 text-indigo-600" />
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-xs font-semibold text-slate-700 truncate">{user.displayName || 'Researcher'}</p>
              <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
            </div>
          </div>
          <button 
            onClick={logout}
            className="w-full py-2.5 text-xs font-bold text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-slate-800">
              {dataset ? dataset.name : 'Welcome to FairTrace AI'}
            </h1>
            <p className="text-xs text-slate-400">
              {dataset ? `Dataset: ${dataset.size.toLocaleString()} samples` : 'Unleash fairness in your AI models'}
            </p>
          </div>
          <div className="flex gap-3">
            <label className="cursor-pointer px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg shadow-sm shadow-indigo-100 hover:bg-indigo-700 transition-colors flex items-center gap-2">
              <FileUp className="w-4 h-4" />
              {isUploading ? 'Uploading...' : 'Upload CSV'}
              <input type="file" className="hidden" accept=".csv" onChange={handleFileUpload} />
            </label>
            {dataset && (
              <button 
                onClick={trainModel}
                disabled={isTraining}
                className="px-4 py-2 bg-white border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-2 group disabled:opacity-50"
              >
                {isTraining ? (
                   <div className="w-4 h-4 border-2 border-slate-300 border-t-indigo-600 rounded-full animate-spin" />
                ) : (
                  <TrendingUp className="w-4 h-4 group-hover:text-indigo-600 transition-colors" />
                )}
                {isTraining ? 'Optimizing...' : 'Train Model'}
              </button>
            )}
            {dataset && !analysis && (
              <button 
                onClick={runAnalysis}
                disabled={isAnalyzing}
                className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-900 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isAnalyzing && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {isAnalyzing ? 'Analyzing...' : 'Run Analysis'}
              </button>
            )}
          </div>
        </header>

        {/* Dashboard Area */}
        <div className="flex-1 p-8 space-y-6 overflow-y-auto relative">
          <AnimatePresence>
            {(isUploading || isTraining || isAnalyzing || isGeneratingReport) && (
              <LoadingOverlay 
                message={
                  isUploading ? "Uploading & Indexing Dataset..." :
                  isTraining ? "Calibrating Machine Learning Model..." :
                  isAnalyzing ? "Scanning for Bias Patterns..." :
                  isGeneratingReport ? "Generating AI Fairness Audit..." : "Processing..."
                }
              />
            )}
            {errors.length > 0 && <DiagnosticCenter errors={errors} onClear={clearError} />}
          </AnimatePresence>

          {!dataset ? (
            <EmptyState 
              onUpload={() => document.querySelector<HTMLInputElement>('input[type="file"]')?.click()} 
              isUploading={isUploading}
            />
          ) : activeTab === 'dashboard' ? (
            <>
              {/* Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <StatCard 
                  title="Fairness Score" 
                  value={analysis ? `${((1 - analysis.demographic_parity) * 100).toFixed(1)}%` : '--'}
                  trend={analysis ? (analysis.demographic_parity < 0.1 ? "+2.4%" : "-1.2%") : undefined}
                  progress={analysis ? (1 - analysis.demographic_parity) * 100 : 0}
                  color={analysis && analysis.demographic_parity < 0.1 ? "emerald" : "amber"}
                />
                <StatCard 
                  title="Disparate Impact" 
                  value={analysis ? analysis.disparate_impact.toFixed(2) : '--'}
                  status={analysis ? analysis.fairness_status : ''}
                  subtext="Target range: 0.80 - 1.25"
                  color={analysis && analysis.fairness_status === 'Fair' ? "emerald" : "rose"}
                />
                <StatCard 
                  title="Demographic Parity" 
                  value={analysis ? analysis.demographic_parity.toFixed(2) : '--'}
                  status={analysis && analysis.demographic_parity > 0.1 ? 'Alert' : 'Clean'}
                  subtext="Gap between privileged groups"
                  color={analysis && analysis.demographic_parity > 0.1 ? "rose" : "emerald"}
                />
                <StatCard 
                  title="Total Records" 
                  value={dataset.size.toLocaleString()}
                  status="Processed"
                  subtext={`Features: ${dataset.columns.length}`}
                  color="indigo"
                />
              </div>

              {/* Data Validation Report */}
              {dataset.validation && (
                <ValidationReport validation={dataset.validation} columns={dataset.columns} />
              )}

              {/* Charts & AI Insight */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-6">
                  {/* Fairness Trends */}
                  {analysis?.trends && analysis.trends.length > 0 && (
                    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col">
                      <div className="flex items-center justify-between mb-6">
                        <div>
                          <h3 className="font-bold text-slate-800">Fairness Metrics Over Time</h3>
                          <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                            {analysis.dateColumnUsed ? `Trend analysis across ${analysis.dateColumnUsed}` : 'Sequential data segment analysis'}
                          </p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                             <span className="text-[10px] font-bold text-slate-400 uppercase">Range:</span>
                             <select 
                               value={trendRange[0]} 
                               onChange={(e) => setTrendRange([parseInt(e.target.value), trendRange[1]])}
                               className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none"
                             >
                               {analysis.trends.map((t, idx) => (
                                 <option key={idx} value={idx} disabled={idx > trendRange[1]}>{t.label.split(' - ')[0] || `Segment ${idx+1}`}</option>
                               ))}
                             </select>
                             <span className="text-slate-300 text-[10px] font-bold">to</span>
                             <select 
                               value={trendRange[1]} 
                               onChange={(e) => setTrendRange([trendRange[0], parseInt(e.target.value)])}
                               className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none"
                             >
                               {analysis.trends.map((t, idx) => (
                                 <option key={idx} value={idx} disabled={idx < trendRange[0]}>{t.label.split(' - ')[1] || `Segment ${idx+1}`}</option>
                               ))}
                             </select>
                          </div>
                          <TrendingUp className="w-4 h-4 text-indigo-600" />
                        </div>
                      </div>
                      <div className="h-[300px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={analysis.trends.slice(trendRange[0], trendRange[1] + 1)}>
                            <defs>
                              <linearGradient id="colorDI" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
                                <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                              </linearGradient>
                              <linearGradient id="colorDP" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.1}/>
                                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                            <XAxis 
                              dataKey="label" 
                              fontSize={10} 
                              tickLine={false} 
                              axisLine={false} 
                              tick={{ fill: '#94a3b8', fontWeight: 600 }}
                              dy={10}
                            />
                            <YAxis 
                              fontSize={10} 
                              tickLine={false} 
                              axisLine={false} 
                              tick={{ fill: '#94a3b8', fontWeight: 600 }}
                              tickFormatter={(val) => val.toFixed(2)}
                            />
                            <Tooltip 
                              contentStyle={{ 
                                backgroundColor: '#fff', 
                                border: '1px solid #e2e8f0', 
                                borderRadius: '12px', 
                                padding: '12px',
                                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                              }}
                              itemStyle={{ fontSize: '10px', fontWeight: 700 }}
                            />
                            <Legend 
                              verticalAlign="top" 
                              align="right" 
                              iconType="circle"
                              wrapperStyle={{ fontSize: '10px', fontWeight: 700, paddingBottom: '20px' }}
                            />
                            <Area 
                              type="monotone" 
                              dataKey="disparate_impact" 
                              name="Disparate Impact" 
                              stroke="#6366f1" 
                              strokeWidth={3}
                              fillOpacity={1} 
                              fill="url(#colorDI)" 
                            />
                            <Area 
                              type="monotone" 
                              dataKey="demographic_parity" 
                              name="Demographic Parity" 
                              stroke="#f43f5e" 
                              strokeWidth={3}
                              fillOpacity={1} 
                              fill="url(#colorDP)" 
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="mt-6 flex items-center gap-4 bg-slate-50 p-3 rounded-xl border border-slate-100">
                        <TrendingDown className="w-4 h-4 text-rose-500" />
                        <p className="text-[10px] font-bold text-slate-500 leading-relaxed uppercase tracking-tight">
                          Ideal Disparate Impact should be between 0.8 and 1.2. demographic parity should be close to 0. 
                          The chart above highlights shifts in fairness as data evolves.
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col">
                  <div className="flex justify-between items-center mb-8">
                    <div>
                      <h3 className="font-bold text-slate-800">Outcome distribution across groups</h3>
                      <p className="text-xs text-slate-400">Comparing positive outcome rates</p>
                    </div>
                  </div>
                  
                  <div className="h-[300px]">
                    {analysis ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 20, right: 30, left: 10, bottom: 10 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} dy={10} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 12 }} unit="%" />
                          <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }} />
                          <Bar dataKey="rate" radius={[6, 6, 0, 0]} barSize={60}>
                            {chartData.map((entry, index) => (
                              <Cell key={index} fill={index === 0 ? '#6366f1' : '#f43f5e'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center bg-slate-50 border border-dashed border-slate-200 rounded-xl">
                        <p className="text-sm text-slate-400 italic">No analysis data. Click "Run Analysis" to generate charts.</p>
                      </div>
                    )}
                  </div>
                </div>
                </div>

                <div className="lg:col-span-4 flex flex-col gap-4">
                  <div className="bg-indigo-900 text-white rounded-2xl p-6 shadow-lg shadow-indigo-100 flex-1 relative overflow-hidden">
                    <div className="absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 bg-white/10 rounded-full blur-3xl"></div>
                    <div className="relative z-10 flex flex-col h-full">
                      <div className="flex items-center gap-2 mb-4">
                        <div className="h-6 w-6 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md">
                          <BrainCircuit className="w-3.5 h-3.5 text-white" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-200">Gemini AI Insight</span>
                      </div>
                      
                      {analysis ? (
                        <>
                          <h4 className="font-bold text-lg mb-2 leading-tight">Bias Pattern Identified</h4>
                          {aiReport ? (
                            <div className="text-sm text-indigo-50/90 leading-relaxed mb-6 h-48 overflow-y-auto pr-2 custom-scrollbar markdown-body">
                               <Markdown>{aiReport}</Markdown>
                            </div>
                          ) : (
                            <p className="text-sm text-indigo-50/80 leading-relaxed mb-6">
                              Analysis suggests that outcomes are disproportionately favoring the privileged group, with a disparate impact of {analysis.disparate_impact.toFixed(2)}. This could indicate proxy bias in features.
                            </p>
                          )}
                          <div className="mt-auto pt-4 border-t border-white/10">
                            {!aiReport && (
                              <button 
                                onClick={generateReport}
                                disabled={isGeneratingReport}
                                className="w-full py-3 bg-white text-indigo-900 text-xs font-bold rounded-xl hover:bg-indigo-50 transition-all shadow-lg flex items-center justify-center gap-2"
                              >
                                {isGeneratingReport ? <div className="w-4 h-4 border-2 border-indigo-900 border-t-transparent rounded-full animate-spin" /> : <Database className="w-4 h-4" />}
                                {isGeneratingReport ? 'Generating...' : 'Generate Full AI Report'}
                              </button>
                            )}
                            {aiReport && (
                              <div className="flex gap-2">
                                <button 
                                  onClick={performMitigation}
                                  className="flex-1 py-3 bg-indigo-500 text-white text-xs font-bold rounded-xl hover:bg-indigo-400 transition-all border border-indigo-400"
                                >
                                  Trigger Mitigation Pipeline
                                </button>
                                <button 
                                  onClick={downloadReport}
                                  disabled={isExporting}
                                  className="px-4 py-3 bg-white/10 hover:bg-white/20 text-white text-xs font-bold rounded-xl transition-all border border-white/20 flex items-center justify-center"
                                  title="Export Report"
                                >
                                  {isExporting ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FileText className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                          <AlertCircle className="w-8 h-8 text-indigo-400 mb-2 opacity-50" />
                          <p className="text-xs text-indigo-300">Run analysis to unlock intelligent insights.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Table / Details */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[500px]">
                <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/30">
                  <div>
                    <h3 className="font-bold text-slate-800">Dataset Preview</h3>
                    <p className="text-[10px] text-slate-400 font-medium">
                      {previewSearchQuery ? `Found ${filteredPreview.length} matches` : `Showing top 100 rows from ${dataset.name}`}
                    </p>
                  </div>
                  <div className="relative">
                    <input 
                      type="text"
                      placeholder="Search rows..."
                      value={previewSearchQuery}
                      onChange={(e) => {
                        setPreviewSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 w-64 transition-all"
                    />
                    <Search className="w-4 h-4 text-slate-300 absolute left-3 top-1/2 -translate-y-1/2" />
                  </div>
                </div>

                {filteredPreview.length > 0 ? (
                  <>
                    <div className="flex-1 overflow-x-auto">
                      <table className="w-full text-left border-collapse min-w-[800px]">
                        <thead>
                          <tr className="bg-slate-50/50">
                             <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">#</th>
                            {dataset.columns.map(col => (
                              <th 
                                key={col} 
                                onClick={() => {
                                  setSortConfig(prev => ({
                                    key: col,
                                    direction: prev?.key === col && prev.direction === 'asc' ? 'desc' : 'asc'
                                  }));
                                }}
                                className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 cursor-pointer hover:bg-slate-100/50 transition-colors"
                              >
                                <div className="flex items-center gap-1">
                                  {col}
                                  {sortConfig?.key === col ? (
                                    sortConfig.direction === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <div className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  )}
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {(() => {
                            const paginated = filteredPreview.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);
                            
                            return paginated.map((row, idx) => (
                              <tr key={idx} className="group hover:bg-slate-50/50 transition-colors">
                                <td className="px-6 py-3 text-xs font-bold text-slate-400 bg-slate-50/10">{(currentPage - 1) * rowsPerPage + idx + 1}</td>
                                {dataset.columns.map(col => (
                                  <td key={col} className="px-6 py-3 text-sm text-slate-600 truncate max-w-[200px]">{String(row[col])}</td>
                                ))}
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between bg-slate-50/30">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Page {currentPage} of {Math.ceil(filteredPreview.length / rowsPerPage)}
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={currentPage === 1}
                          className="px-3 py-1.5 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-white disabled:opacity-50 transition-all"
                        >
                          Previous
                        </button>
                        <button 
                          onClick={() => {
                            const total = Math.ceil(filteredPreview.length / rowsPerPage);
                            setCurrentPage(p => Math.min(total, p + 1));
                          }}
                          disabled={currentPage >= Math.ceil(filteredPreview.length / rowsPerPage)}
                          className="px-3 py-1.5 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-white disabled:opacity-50 transition-all"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 grayscale opacity-40">
                    <Database className="w-12 h-12 text-slate-300 mb-4" />
                    <p className="text-sm font-medium text-slate-400 italic">No record data available in preview.</p>
                  </div>
                )}
              </div>
            </>
          ) : activeTab === 'analysis' ? (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
                <div className="flex items-center gap-3 mb-8">
                   <div className="h-10 w-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                      <BarChart3 className="w-5 h-5 text-indigo-600" />
                   </div>
                   <div>
                      <h3 className="text-xl font-bold text-slate-800">Bias Detection Configuration</h3>
                      <p className="text-sm text-slate-500">Define the metrics to evaluate structural fairness across your dataset.</p>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Target Outcome</label>
                    <select 
                      value={selectedTarget}
                      onChange={e => setSelectedTarget(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium"
                    >
                      {dataset.columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Sensitive Attribute</label>
                    <select 
                      value={selectedSensitive}
                      onChange={e => setSelectedSensitive(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium"
                    >
                      {dataset.columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Privileged Group Value</label>
                    <input 
                      type="text"
                      value={privilegedInput}
                      onChange={e => setPrivilegedInput(e.target.value)}
                      placeholder="e.g. Male or 1"
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium"
                    />
                  </div>
                </div>

                <button 
                  onClick={runAnalysis}
                  disabled={isAnalyzing}
                  className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-2 group disabled:opacity-50"
                >
                  {isAnalyzing && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  <ShieldCheck className="w-5 h-5 group-hover:scale-110 transition-transform" />
                  {isAnalyzing ? 'Analyzing Latent Patterns...' : 'Run Bias Detection Pipeline'}
                </button>
              </div>

              {analysis && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                    <h4 className="font-bold text-slate-800 mb-6 flex items-center gap-2">
                       <TrendingUp className="w-4 h-4 text-emerald-500" />
                       Metric Breakdown
                    </h4>
                    <div className="space-y-4">
                       <div className="flex justify-between items-center p-4 bg-slate-50 rounded-xl">
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-tight">Disparate Impact</span>
                          <span className={cn("text-lg font-bold", analysis.disparate_impact < 0.8 ? "text-rose-600" : "text-emerald-600")}>
                            {analysis.disparate_impact.toFixed(3)}
                          </span>
                       </div>
                       <div className="flex justify-between items-center p-4 bg-slate-50 rounded-xl">
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-tight">Demographic Parity</span>
                          <span className={cn("text-lg font-bold", analysis.demographic_parity > 0.1 ? "text-rose-600" : "text-indigo-600")}>
                            {analysis.demographic_parity.toFixed(3)}
                          </span>
                       </div>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                    <div className="flex justify-between items-center mb-6">
                      <h4 className="font-bold text-slate-800 flex items-center gap-2">
                         <AlertCircle className="w-4 h-4 text-amber-500" />
                         Fairness Summary
                      </h4>
                      <button 
                        onClick={downloadReport}
                        disabled={isExporting}
                        className="flex items-center gap-2 text-[10px] font-bold text-indigo-600 hover:text-indigo-700 transition-colors bg-indigo-50 px-3 py-1.5 rounded-lg"
                      >
                        <FileText className="w-3 h-3" />
                        {isExporting ? 'EXPORTING...' : 'EXPORT REPORT'}
                      </button>
                    </div>
                    <div className="p-4 rounded-xl border border-dashed border-slate-200 text-center">
                       <p className="text-sm text-slate-500 leading-relaxed mb-4">
                          Based on the 80% rule, this model is classified as:
                       </p>
                       <div className={cn(
                         "inline-block px-6 py-2 rounded-full text-sm font-bold uppercase tracking-widest",
                         analysis.fairness_status === 'Fair' ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                       )}>
                         {analysis.fairness_status}
                       </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === 'simulations' ? (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                   <div className="h-10 w-10 bg-indigo-50 rounded-xl flex items-center justify-center">
                      <Zap className="w-5 h-5 text-indigo-600" />
                   </div>
                   <div>
                      <h3 className="text-xl font-bold text-slate-800">Decision Simulator</h3>
                      <p className="text-sm text-slate-500">Analyze real-time model predictions for potential bias influence.</p>
                   </div>
                </div>
                
                {/* Model Selector */}
                <div className="flex gap-2 mb-8 p-1 bg-slate-100 rounded-2xl w-fit">
                   <button 
                     onClick={() => setActiveModel('baseline')}
                     className={cn(
                       "px-4 py-2 text-xs font-bold rounded-xl transition-all",
                       activeModel === 'baseline' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                     )}
                   >
                     Baseline Model
                   </button>
                   <button 
                     onClick={() => setActiveModel('mitigated')}
                     disabled={!mitigationInfo}
                     className={cn(
                       "px-4 py-2 text-xs font-bold rounded-xl transition-all",
                       activeModel === 'mitigated' ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-700",
                       !mitigationInfo && "opacity-50 cursor-not-allowed"
                     )}
                   >
                     Mitigated Model
                   </button>
                </div>

                {activeModel === 'mitigated' && mitigationInfo && (
                  <div className="mb-8 p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
                    <p className="text-xs font-medium text-emerald-800">
                      Using Fairness-Aware model. Features associated with bias (e.g. <b>{mitigationInfo.removed_feature}</b>) have been blinded.
                    </p>
                  </div>
                )}

                {Object.keys(predictionInput).length > 0 ? (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                      {dataset.columns
                        .filter(feat => {
                          const isTarget = feat === selectedTarget;
                          if (isTarget) return false;
                          if (activeModel === 'mitigated') {
                            return feat !== selectedSensitive;
                          }
                          return true;
                        })
                        .map(feat => (
                        <div key={feat} className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{feat}</label>
                          <input 
                            type="number"
                            step="0.01"
                            value={predictionInput[feat] || '0'}
                            onChange={e => setPredictionInput({ ...predictionInput, [feat]: e.target.value })}
                            className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-sm transition-all"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-center border-t border-slate-50 pt-8">
                      <button 
                        onClick={getPrediction}
                        disabled={isPredicting}
                        className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 hover:-translate-y-0.5 transition-all flex items-center gap-3 disabled:opacity-50"
                      >
                        {isPredicting ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                        {isPredicting ? 'Computing Fairness...' : 'Predict Fair Outcome'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-12 bg-slate-50 rounded-2xl border border-dashed border-slate-200 flex flex-col items-center">
                    <Database className="w-8 h-8 text-slate-300 mb-2" />
                    <p className="text-sm text-slate-400 mb-4">Baseline model not trained. Predictions require a trained context.</p>
                    <button 
                      onClick={trainModel}
                      disabled={isTraining}
                      className="px-6 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800 transition-all flex items-center gap-2"
                    >
                      {isTraining && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                      Initialize Model Training
                    </button>
                  </div>
                )}
              </div>

              <AnimatePresence>
                {predictionResult && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={cn(
                      "p-8 rounded-2xl border-2 flex items-center justify-between shadow-lg",
                      predictionResult.prediction === 1 
                        ? "bg-emerald-50 border-emerald-100 shadow-emerald-100" 
                        : "bg-rose-50 border-rose-100 shadow-rose-100"
                    )}
                  >
                    <div>
                      <h4 className={cn("text-xl font-bold mb-1", predictionResult.prediction === 1 ? "text-emerald-800" : "text-rose-800")}>
                        {predictionResult.prediction === 1 ? "Positive Outcome" : "Negative Outcome"}
                      </h4>
                      <p className={cn("text-sm font-medium", predictionResult.prediction === 1 ? "text-emerald-600" : "text-rose-600")}>
                        Propensity Score: {(predictionResult.probability * 100).toFixed(1)}%
                      </p>
                      <div className="mt-4 flex gap-2">
                         <span className="px-2.5 py-1 bg-white/50 rounded-lg text-[10px] font-bold text-slate-500 border border-white/20 uppercase tracking-tight">MODEL DECISION</span>
                         {predictionResult.probability > 0.4 && predictionResult.probability < 0.6 && (
                            <span className="px-2.5 py-1 bg-amber-100 rounded-lg text-[10px] font-bold text-amber-700 uppercase tracking-tight">Low Confidence</span>
                         )}
                      </div>
                    </div>
                    <div className={cn(
                      "h-16 w-16 rounded-full flex items-center justify-center shadow-xl",
                      predictionResult.prediction === 1 ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"
                    )}>
                      {predictionResult.prediction === 1 ? <CheckCircle2 className="w-8 h-8" /> : <AlertCircle className="w-8 h-8" />}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : activeTab === 'mitigation' ? (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="bg-white border border-slate-200 rounded-3xl p-10 shadow-sm text-center">
                 <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                    <ShieldCheck className="w-10 h-10 text-emerald-600" />
                 </div>
                 <h3 className="text-2xl font-bold text-slate-800 mb-2">Mitigation Pipeline Active</h3>
                 <p className="text-slate-500 max-w-lg mx-auto mb-8">
                   We have successfully deployed a <b>Fairness-Aware</b> model using {mitigationInfo?.technique || 'Attribute Blinding'}. 
                   The sensitive attribute <b>"{mitigationInfo?.removed_feature}"</b> has been removed to ensure demographic parity.
                 </p>
                 
                 <div className="grid grid-cols-2 gap-4 max-w-md mx-auto">
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                       <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Status</p>
                       <p className="text-sm font-bold text-emerald-600">DEPLOYED</p>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                       <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Technique</p>
                       <p className="text-sm font-bold text-slate-700">Pre-processing</p>
                    </div>
                 </div>
                 
                 <button 
                  onClick={() => setActiveTab('simulations')}
                  className="mt-10 px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 mx-auto"
                 >
                   Test Mitigated Model <ArrowRight className="w-4 h-4" />
                 </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center min-h-[400px] text-slate-400 italic">Feature under development</div>
          )}
        </div>
      </main>
    </div>
  );
}

// Sub-components
function DiagnosticCenter({ errors, onClear }: { errors: FairTraceError[], onClear: (id: string) => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="bg-rose-50 border border-rose-100 rounded-2xl overflow-hidden shadow-xl shadow-rose-100/50 mb-6"
    >
      <div className="px-6 py-4 border-b border-rose-100 flex items-center justify-between bg-rose-50/50">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-rose-600" />
          <h3 className="text-sm font-bold text-rose-800">Diagnostic Center</h3>
          <span className="bg-rose-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">{errors.length}</span>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-rose-100">
        {errors.map((err) => (
          <div key={err.id} className="p-4 hover:bg-white/50 transition-colors">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded",
                    err.type === 'database' ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"
                  )}>
                    {err.type}
                  </span>
                  <span className="text-[10px] text-slate-400 font-medium">
                    {err.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-sm font-bold text-slate-800 leading-tight mb-2">{err.message}</p>
                {err.details && (
                  <pre className="text-[10px] bg-slate-900 text-slate-300 p-3 rounded-lg overflow-x-auto font-mono leading-relaxed max-h-32 mb-2">
                    {err.details}
                  </pre>
                )}
              </div>
              <button 
                onClick={() => onClear(err.id)}
                className="text-slate-400 hover:text-rose-600 transition-colors p-1"
              >
                <LogOut className="w-4 h-4 rotate-45" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function LoadingOverlay({ message }: { message: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 bg-white/60 backdrop-blur-[2px] flex items-center justify-center p-8 text-center"
    >
      <div className="max-w-xs w-full">
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-indigo-100 rounded-full" />
            <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin absolute top-0 left-0" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Zap className="w-6 h-6 text-indigo-600 animate-pulse" />
            </div>
          </div>
        </div>
        <h3 className="text-sm font-bold text-slate-800 mb-2">{message}</h3>
        <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest animate-pulse">Please do not refresh</p>
        
        {/* Simulated Progress Bar */}
        <div className="mt-6 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <motion.div 
            initial={{ x: "-100%" }}
            animate={{ x: "0%" }}
            transition={{ 
              duration: 2, 
              repeat: Infinity, 
              ease: "easeInOut" 
            }}
            className="h-full w-full bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-500"
          />
        </div>
      </div>
    </motion.div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean, icon: React.ReactNode, label: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-medium transition-all duration-300 group",
        active 
          ? "bg-indigo-50 text-indigo-700 shadow-sm" 
          : "text-slate-500 hover:bg-slate-100/50 hover:text-slate-900"
      )}
    >
      {React.cloneElement(icon as React.ReactElement<any>, { 
        className: cn("w-5 h-5 transition-colors", active ? "text-indigo-600" : "text-slate-400 group-hover:text-slate-600") 
      })}
      <span className="text-sm">{label}</span>
      {active && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400"></div>}
    </button>
  );
}

function StatCard({ title, value, trend, status, subtext, progress, color }: any) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all group">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 group-hover:text-indigo-400 transition-colors">{title}</p>
      <div className="flex items-end justify-between">
        <h2 className="text-3xl font-bold text-slate-800 tracking-tight">{value}</h2>
        <div className="flex flex-col items-end gap-1">
           {trend && (
             <span className={cn(
               "text-[10px] font-bold px-2 py-1 rounded-lg flex items-center gap-1",
               trend.startsWith('+') ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
             )}>
               {trend.startsWith('+') ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
               {trend}
             </span>
           )}
           {status && (
             <span className={cn(
               "text-[10px] font-bold px-2 py-1 rounded-lg",
               color === 'emerald' ? "bg-emerald-50 text-emerald-600" : 
               color === 'rose' ? "bg-rose-50 text-rose-600" : 
               color === 'amber' ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-600"
             )}>
               {status}
             </span>
           )}
        </div>
      </div>
      {progress !== undefined && (
        <div className="w-full bg-slate-100 h-2 rounded-full mt-6 overflow-hidden">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 1.2 }}
            className={cn("h-full rounded-full shadow-inner", 
              color === 'emerald' ? 'bg-emerald-500' : 
              color === 'rose' ? 'bg-rose-500' : 
              color === 'amber' ? 'bg-amber-500' : 'bg-indigo-500'
            )}
          />
        </div>
      )}
      {subtext && <p className="text-[10px] text-slate-400 mt-4 font-medium italic">{subtext}</p>}
    </div>
  );
}

function EmptyState({ onUpload, isUploading }: { onUpload: () => void, isUploading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-12 bg-white border border-slate-100 rounded-[3rem] shadow-sm relative overflow-hidden group">
      <div className="absolute inset-0 bg-indigo-50/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
      <div className="w-24 h-24 bg-indigo-50 rounded-[2rem] flex items-center justify-center mb-8 shadow-xl shadow-indigo-100/50 group-hover:scale-110 transition-transform">
        <Database className="w-12 h-12 text-indigo-600" />
      </div>
      <h2 className="text-3xl font-bold text-slate-800 mb-4">Integrate your data</h2>
      <p className="text-slate-500 max-w-md mb-10 text-base leading-relaxed">
        Upload a CSV dataset to initiate the bias detection pipeline. FairTrace AI will analyze sensitive features and model outcomes for structural imbalances.
      </p>
      <button 
        onClick={onUpload}
        disabled={isUploading}
        className="px-10 py-4 bg-indigo-600 text-white rounded-[1.5rem] font-bold shadow-2xl shadow-indigo-200 hover:bg-indigo-700 hover:-translate-y-1 transition-all flex items-center gap-4 text-lg disabled:opacity-50"
      >
        {isUploading ? <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin" /> : <FileUp className="w-6 h-6" />}
        {isUploading ? 'Preparing Data...' : 'Start Analysis'}
      </button>
      <div className="mt-12 flex gap-8">
         <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            CSV Support
         </div>
         <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Instant Metrics
         </div>
         <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            AI Explanations
         </div>
      </div>
    </div>
  );
}

function ValidationReport({ validation, columns }: { 
  validation: NonNullable<DatasetMetadata['validation']>,
  columns: string[]
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden mb-6"
    >
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/20">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-indigo-600" />
          <h3 className="text-sm font-bold text-slate-800">Quality & Format Validation</h3>
        </div>
        <button 
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors"
        >
          {showDetails ? 'Hide Details' : 'View Full Report'}
        </button>
      </div>

      <div className="p-6">
        {validation.issues.length > 0 ? (
          <div className="flex flex-col gap-3 mb-6">
            {validation.issues.map((issue, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <p className="text-xs font-medium text-amber-800">{issue}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 p-3 bg-emerald-50 rounded-xl border border-emerald-100 mb-6">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <p className="text-xs font-medium text-emerald-800">No major quality issues detected. Structural integrity is high.</p>
          </div>
        )}

        {showDetails && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50">
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Column</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Detected Type</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Missing Values</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Unique Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {columns.map(col => (
                  <tr key={col} className="hover:bg-slate-50/30 transition-colors">
                    <td className="px-4 py-2 text-xs font-bold text-slate-700">{col}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                        validation.dataTypes[col] === 'numeric' ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-700"
                      )}>
                        {validation.dataTypes[col]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      <span className={cn(
                        validation.missingValues[col] > 0 ? "text-rose-600 font-bold" : "text-slate-400"
                      )}>
                        {validation.missingValues[col]} ({Math.round((validation.missingValues[col] / validation.totalRows) * 100)}%)
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {validation.uniqueValues[col]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </motion.div>
  );
}
