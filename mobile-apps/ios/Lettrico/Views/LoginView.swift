//
//  LoginView.swift
//  Lettrico
//
//  Modern login screen with SwiftUI
//

import SwiftUI

struct LoginView: View {
    @EnvironmentObject var authManager: AuthManager
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var isLoading = false
    @State private var showRegister = false
    
    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 0.12, green: 0.23, blue: 0.68),
                    Color(red: 0.12, green: 0.25, blue: 0.69),
                    Color(red: 0.23, green: 0.51, blue: 0.98)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
            
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Text("Lettrico")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundColor(.white)
                    
                    Text("Turn applications into opportunities")
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.9))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
                
                // Card
                VStack(spacing: 20) {
                    // Email field
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Email Address")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.gray)
                        
                        TextField("your.email@example.com", text: $email)
                            .textInputAutocapitalization(.never)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .padding(12)
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                    }
                    
                    // Password field
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Password")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.gray)
                        
                        HStack {
                            if showPassword {
                                TextField("Enter your password", text: $password)
                                    .textContentType(.password)
                            } else {
                                SecureField("Enter your password", text: $password)
                                    .textContentType(.password)
                            }
                            
                            Button(action: { showPassword.toggle() }) {
                                Image(systemName: showPassword ? "eye.slash" : "eye")
                                    .foregroundColor(.gray)
                            }
                        }
                        .padding(12)
                        .background(Color(.systemGray6))
                        .cornerRadius(8)
                    }
                    
                    // Error message
                    if let errorMessage = authManager.errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(12)
                            .background(Color.red.opacity(0.1))
                            .cornerRadius(8)
                    }
                    
                    // Login button
                    Button(action: {
                        isLoading = true
                        Task {
                            await authManager.login(email: email, password: password)
                            isLoading = false
                        }
                    }) {
                        if isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Sign In")
                                .fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(14)
                    .background(
                        LinearGradient(
                            gradient: Gradient(colors: [
                                Color(red: 0.12, green: 0.25, blue: 0.69),
                                Color(red: 0.23, green: 0.51, blue: 0.98)
                            ]),
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .disabled(isLoading)
                    
                    // Register link
                    HStack(spacing: 4) {
                        Text("Don't have an account?")
                            .foregroundColor(.gray)
                        
                        Button("Create account") {
                            showRegister = true
                        }
                        .foregroundColor(Color(red: 0.12, green: 0.25, blue: 0.69))
                        .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
                }
                .padding(24)
                .background(Color.white)
                .cornerRadius(12)
                .shadow(radius: 8)
                .padding(20)
                
                Spacer()
            }
        }
        .sheet(isPresented: $showRegister) {
            RegisterView()
                .environmentObject(authManager)
        }
    }
}

#Preview {
    LoginView()
        .environmentObject(AuthManager())
}
