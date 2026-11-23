// Road Safety Explorer: all cloud resources in one resource group.
//
//   Static Web App (Free)        React front end
//   Function App (Flex Consumption, Python)   HTTP API + Durable Functions workflow
//   Storage account              input files, partitions, results, job records,
//                                Durable task hub, deployment package
//   Log Analytics + App Insights monitoring
//
// Deploy: az deployment group create -g <rg> -f infra/main.bicep

@description('Region for the function app, storage and monitoring.')
param location string = resourceGroup().location

@description('Region for the Static Web App. The Free plan is only offered in a few regions.')
@allowed(['westeurope', 'eastus2', 'centralus', 'westus2', 'eastasia'])
param staticWebAppLocation string = 'westeurope'

@description('Short token that makes resource names globally unique.')
@minLength(3)
param resourceToken string = toLower(uniqueString(subscription().id, resourceGroup().id))

@description('Python version for the function app.')
@allowed(['3.10', '3.11', '3.12', '3.13'])
param pythonVersion string = '3.12'

@description('Memory per function app instance. Also used in the compute cost estimate.')
@allowed([512, 2048, 4096])
param instanceMemoryMB int = 2048

@description('Upper limit on scale-out. 40 is the lowest value Flex Consumption accepts.')
@minValue(40)
@maxValue(1000)
param maximumInstanceCount int = 40

@description('Collision years the API will accept (DfT publishes single-year files for the last five years).')
param allowedYears string = '2021,2022,2023,2024,2025'

var storageName = 'strse${resourceToken}'
var functionAppName = 'func-rse-${resourceToken}'
var deploymentContainerName = 'app-package'
var dataContainerName = 'roadsafety'
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'

// ---------------------------------------------------------------- monitoring
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-rse-${resourceToken}'
  location: location
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
    workspaceCapping: { dailyQuotaGb: 1 } // cost guard for a coursework project
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-rse-${resourceToken}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ------------------------------------------------------------------- storage
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }

  resource blobServices 'blobServices' = {
    name: 'default'

    resource deploymentContainer 'containers' = {
      name: deploymentContainerName
    }

    resource dataContainer 'containers' = {
      name: dataContainerName
    }
  }
}

// ------------------------------------------------------------ static web app
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-rse-${resourceToken}'
  location: staticWebAppLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

// -------------------------------------------------------------- function app
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-rse-${resourceToken}'
  location: location
  kind: 'functionapp'
  sku: { tier: 'FlexConsumption', name: 'FC1' }
  properties: { reserved: true }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: [
          'https://${staticWebApp.properties.defaultHostname}'
          'http://localhost:5173'
        ]
      }
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'StorageAccountConnectionString'
            storageAccountConnectionStringName: 'DEPLOYMENT_STORAGE_CONNECTION_STRING'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: instanceMemoryMB
      }
      runtime: {
        name: 'python'
        version: pythonVersion
      }
    }
  }

  resource appSettings 'config' = {
    name: 'appsettings'
    properties: {
      AzureWebJobsStorage: storageConnectionString
      DEPLOYMENT_STORAGE_CONNECTION_STRING: storageConnectionString
      APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
      DATA_CONTAINER: dataContainerName
      ALLOWED_YEARS: allowedYears
      INSTANCE_MEMORY_MB: string(instanceMemoryMB)
    }
  }
}

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output staticWebAppName string = staticWebApp.name
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output storageAccountName string = storage.name
output applicationInsightsName string = appInsights.name
