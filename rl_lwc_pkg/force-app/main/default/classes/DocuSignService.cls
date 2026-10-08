/**
 * DocuSignService
 * Handles DocuSign API integration for document signing
 */
public without sharing class DocuSignService {

    public class DocuSignConfig {
        public String accountId;
        public String clientId;
        public String clientSecret;
        public String baseUrl;
    }

    public class SigningResponse {
        @AuraEnabled public String envelopeId;
        @AuraEnabled public String signingUrl;
        @AuraEnabled public String status;
    }

    private static final String DS_CONFIG_NAME = 'DocuSign_Config';

    /**
     * getConfig - Retrieve DocuSign credentials from custom settings
     */
    public static DocuSignConfig getConfig() {
        // TODO: Store in custom setting or custom metadata
        // For now, return placeholder - user must configure
        DocuSignConfig config = new DocuSignConfig();
        config.accountId = System.Label.DocuSign_Account_Id;
        config.clientId = System.Label.DocuSign_Client_Id;
        config.clientSecret = System.Label.DocuSign_Client_Secret;
        config.baseUrl = System.Label.DocuSign_Base_Url;
        return config;
    }

    /**
     * createEmbeddedSigningEnvelope
     * Creates a DocuSign envelope for embedded signing
     */
    @AuraEnabled
    public static SigningResponse createEmbeddedSigningEnvelope(
        Id orderId,
        String signerEmail,
        String signerName
    ) {
        // If email/name not provided, use current user's info
        if (String.isBlank(signerEmail)) {
            signerEmail = UserInfo.getUserEmail();
        }
        if (String.isBlank(signerName)) {
            signerName = UserInfo.getName();
        }
        SigningResponse response = new SigningResponse();

        try {
            DocuSignConfig config = getConfig();

            // Validate config
            if (String.isBlank(config.accountId) || String.isBlank(config.clientId)) {
                throw new AuraHandledException(
                    'DocuSign is not configured. Please set up DocuSign API credentials.'
                );
            }

            // Get access token
            String accessToken = getAccessToken(config);

            // Get order details for document
            Order order = [
                SELECT Id, OrderNumber, Account.Name, EffectiveDate, TotalAmount
                FROM Order
                WHERE Id = :orderId
                LIMIT 1
            ];

            // Create envelope JSON payload
            String envelopePayload = buildEnvelopePayload(order, signerEmail, signerName);

            // Create envelope via API
            HttpRequest request = new HttpRequest();
            request.setMethod('POST');
            request.setEndpoint(config.baseUrl + '/v2.1/accounts/' + config.accountId + '/envelopes');
            request.setHeader('Authorization', 'Bearer ' + accessToken);
            request.setHeader('Content-Type', 'application/json');
            request.setBody(envelopePayload);

            Http http = new Http();
            HttpResponse httpResponse = http.send(request);

            if (httpResponse.getStatusCode() == 201) {
                Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
                    httpResponse.getBody()
                );
                response.envelopeId = (String) result.get('envelopeId');
                response.status = (String) result.get('status');

                // Get embedded signing URL
                response.signingUrl = getEmbeddedSigningUrl(
                    config,
                    accessToken,
                    response.envelopeId,
                    signerEmail,
                    signerName
                );
            } else {
                throw new AuraHandledException(
                    'Failed to create DocuSign envelope: ' + httpResponse.getStatus()
                );
            }
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }

        return response;
    }

    /**
     * getAccessToken - Obtain OAuth token from DocuSign
     */
    private static String getAccessToken(DocuSignConfig config) {
        HttpRequest request = new HttpRequest();
        request.setMethod('POST');
        request.setEndpoint('https://account-d.docusign.com/oauth/token');
        request.setHeader('Content-Type', 'application/x-www-form-urlencoded');

        String body = 'grant_type=client_credentials&client_id=' +
            EncodingUtil.urlEncode(config.clientId, 'UTF-8') +
            '&client_secret=' +
            EncodingUtil.urlEncode(config.clientSecret, 'UTF-8') +
            '&scope=signature';
        request.setBody(body);

        Http http = new Http();
        HttpResponse response = http.send(request);

        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
            response.getBody()
        );
        return (String) result.get('access_token');
    }

    /**
     * getEmbeddedSigningUrl - Get URL for embedded signing in iframe
     */
    private static String getEmbeddedSigningUrl(
        DocuSignConfig config,
        String accessToken,
        String envelopeId,
        String signerEmail,
        String signerName
    ) {
        // Create recipient view request
        String returnUrl = System.URL.getOrgDomainUrl().toExternalForm() + '/lightning/r/Order/';
        Map<String, Object> recipientView = new Map<String, Object>{
            'returnUrl' => returnUrl,
            'authenticationMethod' => 'none',
            'email' => signerEmail,
            'userName' => signerName,
            'clientUserId' => UserInfo.getUserId()
        };

        HttpRequest request = new HttpRequest();
        request.setMethod('POST');
        request.setEndpoint(
            config.baseUrl +
            '/v2.1/accounts/' +
            config.accountId +
            '/envelopes/' +
            envelopeId +
            '/views/recipient'
        );
        request.setHeader('Authorization', 'Bearer ' + accessToken);
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(recipientView));

        Http http = new Http();
        HttpResponse response = http.send(request);

        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
            response.getBody()
        );
        return (String) result.get('url');
    }

    /**
     * buildEnvelopePayload - Create DocuSign envelope JSON
     */
    private static String buildEnvelopePayload(Order order, String signerEmail, String signerName) {
        // Create a simple text document with order details
        String documentContent =
            'ORDER CONFIRMATION\n\n' +
            'Order Number: ' +
            order.OrderNumber +
            '\n' +
            'Account: ' +
            order.Account.Name +
            '\n' +
            'Effective Date: ' +
            String.valueOf(order.EffectiveDate) +
            '\n' +
            'Total Amount: $' +
            String.valueOf(order.TotalAmount) +
            '\n\n' +
            'Please sign to confirm this order.';

        String base64Doc = EncodingUtil.base64Encode(Blob.valueOf(documentContent));

        Map<String, Object> envelope = new Map<String, Object>{
            'emailSubject' => 'Order Confirmation - ' + order.OrderNumber,
            'documents' => new List<Map<String, Object>>{
                new Map<String, Object>{
                    'documentBase64' => base64Doc,
                    'name' => 'Order_' + order.OrderNumber + '.txt',
                    'fileExtension' => 'txt',
                    'documentId' => '1'
                }
            },
            'recipients' => new Map<String, Object>{
                'signers' => new List<Map<String, Object>>{
                    new Map<String, Object>{
                        'email' => signerEmail,
                        'name' => signerName,
                        'recipientId' => '1',
                        'routingOrder' => '1',
                        'clientUserId' => UserInfo.getUserId(),
                        'tabs' => new Map<String, Object>{
                            'signHereTabs' => new List<Map<String, Object>>{
                                new Map<String, Object>{
                                    'documentId' => '1',
                                    'pageNumber' => '1',
                                    'xPosition' => '100',
                                    'yPosition' => '200'
                                }
                            }
                        }
                    }
                }
            },
            'status' => 'sent'
        };

        return JSON.serialize(envelope);
    }

    /**
     * checkEnvelopeStatus - Poll envelope status
     */
    @AuraEnabled
    public static String checkEnvelopeStatus(String envelopeId) {
        try {
            DocuSignConfig config = getConfig();
            String accessToken = getAccessToken(config);

            HttpRequest request = new HttpRequest();
            request.setMethod('GET');
            request.setEndpoint(
                config.baseUrl + '/v2.1/accounts/' + config.accountId + '/envelopes/' + envelopeId
            );
            request.setHeader('Authorization', 'Bearer ' + accessToken);

            Http http = new Http();
            HttpResponse response = http.send(request);

            Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
                response.getBody()
            );
            return (String) result.get('status');
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }
}
