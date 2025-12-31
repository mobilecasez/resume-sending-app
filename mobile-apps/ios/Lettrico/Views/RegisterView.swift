//
//  RegisterView.swift
//  Lettrico
//
//  Registration screen with modern design
//

import SwiftUI

struct RegisterView: View {
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var authManager: AuthManager
    @State private var fullName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var isLoading = false
    
    var isFormValid: Bool {
        !fullName.isEmpty && !email.isEmpty && !password.isEmpty &&
        password == confirmPassword && password.count >= 6
    }
    
    var body: some View {
        NavigationView {
            ZStack {
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
                        Text("Create Account")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(.white)
                        
                        Text("Join Lettrico today")
                            .font(.subheadline)
                            .foregroundColor(.white.opacity(0.9))
                    }
                    
                    // Form
                    VStack(spacing: 16) {
                        // Full Name
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Full Name")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.gray)
                            
                            TextField("Your name", text: $fullName)
                                .padding(12)
                                .background(Color(.systemGray6))
                                .cornerRadius(8)
                        }
                        
                        // Email
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Email Address")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.gray)
                            
                            TextField("your.email@example.com", text: $email)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.emailAddress)
                                .padding(12)
                                .background(Color(.systemGray6))
                                .cornerRadius(8)
                        }
                        
                        // Password
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Password")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.gray)
                            
                            SecureField("At least 6 characters", text: $password)
                                .padding(12)
                                .background(Color(.systemGray6))
                                .cornerRadius(8)
                        }
                        
                        // Confirm Password
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Confirm Password")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.gray)
                            
                            SecureField("Re-enter password", text: $confirmPassword)
                                .padding(12)
                                .background(Color(.systemGray6))
                                .cornerRadius(8)
                        }
                        
                        if !password.isEmpty && password != confirmPassword {
                            Text("Passwords don't match")
                                .font(.caption)
                                .foregroundColor(.red)
                        }
                        
                        if let errorMessage = authManager.errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(12)
                                .background(Color.red.opacity(0.1))
                                .cornerRadius(8)
                        }
                        
                        // Register button
                        Button(action: {
                            isLoading = true
                            Task {
                                await authManager.register(fullName: fullName, email: email, password: password)
                                isLoading = false
                                if authManager.isLoggedIn {
                                    dismiss()
                                }
                            }
                        }) {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text("Create Account")
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(14)
                        .background(isFormValid ? Color(red: 0.12, green: 0.25, blue: 0.69) : Color.gray)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                        .disabled(!isFormValid || isLoading)
                    }
                    .padding(24)
                    .background(Color.white)
                    .cornerRadius(12)
                    .shadow(radius: 8)
                    .padding(20)
                    
                    Spacer()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        HStack {
                            Image(systemName: "chevron.left")
                            Text("Back")
                        }
                        .foregroundColor(.white)
                    }
                }
            }
        }
    }
}
